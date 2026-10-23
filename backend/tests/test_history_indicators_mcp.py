"""MCP indicators bind prices, calculations and evidence to a published version."""

import json

import pytest
from alerts.chart_indicators import calculate
from alerts.fixed_indicators import indicator_tick
from alerts.history_artifacts import read_artifact
from alerts.history_versions import create_version
from alerts.mcp.auth import issue
from alerts.storage import (
    FixedIndicatorRun,
    HistoryArtifact,
    HistoryReclamation,
    HistoryVersion,
    MarketDemand,
    now_ms,
)
from sqlalchemy import select
from test_composite_definitions import publish
from test_fixed_indicators import drain, history
from test_history_retention import prepared
from test_market_contracts import identity
from test_native_mcp import call, rpc
from test_native_mcp import mcp as mcp

SPEC = {"name": "EMA", "params": {"period": 19}}


def query(version, **changes):
    return {"instrument": version, "series_kind": "history", "timeframe": "M1",
            "limit": 7, "indicators": [SPEC],
            "indicator_input_policy": "strict_confirmed_v1", **changes}


def page(client, token, arguments):
    result = call(client, token, "indicators_calculate", arguments)
    assert not result["isError"], result
    return result["structuredContent"]["page"]


def forbid_market_io(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("Fixed history indicators cannot download or renew market demand")
    monkeypatch.setattr("alerts.market_data.renew_demand", forbidden)
    monkeypatch.setattr("alerts.provider_chart.data", forbidden)


def test_history_indicator_schema_and_scope_contract(mcp):
    client, token, factory = mcp
    tools = rpc(client, token, "tools/list").json()["result"]["tools"]
    indicator = next(t for t in tools if t["name"] == "indicators_calculate")
    assert "history" in indicator["inputSchema"]["properties"]["series_kind"]["enum"]
    for field in ("version_id", "input_manifest", "checksum", "history_checksum", "input_evidence"):
        assert field in json.dumps(indicator["outputSchema"])
    for name in ("market_get_bars", "market_get_quote"):
        tool = next(t for t in tools if t["name"] == name)
        assert tool["inputSchema"]["properties"]["series_kind"]["enum"] == ["managed", "provider"]
    for scopes in (["market:read"], ["analysis:read"]):
        limited = issue("missing-scope", scopes, now_ms() + 60000)
        result = call(client, limited, "indicators_calculate", query("00000000-0000-0000-0000-000000000001"))
        assert result["structuredContent"]["error"]["code"] == "FORBIDDEN"
    with factory.begin() as db:
        assert db.scalar(select(FixedIndicatorRun)) is None


def test_history_cold_partial_ready_full_prefix_and_browser_parity(mcp, monkeypatch):
    client, token, factory = mcp
    version = history(factory, monkeypatch, count=2107)
    forbid_market_io(monkeypatch)
    arguments = query(version, before=1000 * 60000)
    first = page(client, token, arguments)
    assert len(first["bars"]) == 7 and first["pending"]
    assert first["version_id"] == first["history_version_id"] == version
    assert first["input_manifest"] == {"version_id": version, "checksum": first["history_checksum"]}
    calc = first["indicators"][0]["calculation"]
    assert calc["input_evidence"]["history_version_id"] == version
    assert not calc["visible_complete"] and calc["calculation_origin"] == 0
    run_id = calc["run_id"]
    indicator_tick(run_id)
    partial = page(client, token, arguments)
    calc = partial["indicators"][0]["calculation"]
    assert calc["status"] == "partial" and calc["visible_complete"]
    assert calc["coverage"] == calc["required_coverage"]
    drain(run_id)
    ready = page(client, token, arguments)
    browser = client.post("/api/charts/data", json=arguments | {"track_history": True}).json()
    for field in ("bars", "indicators", "input_manifest", "version_id", "history_checksum"):
        assert ready[field] == browser[field]
    with factory.begin() as db:
        rows = read_artifact(db, version, "M1", limit=20000)
        expected = calculate(rows[:1000], SPEC)["series"][0]["values"][-7:]
        assert db.scalar(select(MarketDemand)) is None
        assert len(list(db.scalars(select(FixedIndicatorRun)))) == 1
    values = ready["indicators"][0]["series"][0]["values"]
    assert values == expected
    assert {v["time"] for v in values} == {b["start"] for b in ready["bars"]}
    assert all(dep["dependency_origin"] == 0 for dep in ready["indicators"][0]["dependencies"])
    result = call(client, token, "indicators_calculate", arguments)["structuredContent"]
    assert result["cursor_coordinate"] == "utc_ms"
    assert result["next_before"] == ready["bars"][0]["start"]
    older = page(client, token, query("MWH:" + version.upper(), before=result["next_before"]))
    assert max(b["start"] for b in older["bars"]) < result["next_before"]
    assert older["indicators"][0]["calculation"]["run_id"] == run_id


def test_history_input_validation_is_atomic(mcp, monkeypatch):
    client, token, factory = mcp
    version = history(factory, monkeypatch, count=30)
    forbid_market_io(monkeypatch)
    for changes in ({"instrument": "MWH:" + version, "series_kind": "managed"},
                    {"instrument": "not-a-version"}, {"instrument": "MWC:" + "a" * 64},
                    {"published": True}, {"dataset_start": 0}, {"calculation_origin": 0},
                    {"input_revision": 0}, {"composite_revision_id": version},
                    {"indicators": [SPEC, {"name": "EMA", "params": {"period": 0}}]},
                    {"limit": 2001}, {"display_snapshot_id": "a" * 64}):
        result = call(client, token, "indicators_calculate", query(version, **changes))
        assert result["isError"] and result["structuredContent"]["error"]["code"] == "INVALID_ARGUMENT", result
    # A spec accepted by the catalog must also be supported by fixed-state jobs.
    from alerts import indicator_state

    monkeypatch.setattr(indicator_state, "SUPPORTED", indicator_state.SUPPORTED - {"RSI"})
    result = call(client, token, "indicators_calculate",
                  query(version, indicators=[SPEC, {"name": "RSI", "params": {"period": 2}}]))
    assert result["structuredContent"]["error"]["code"] == "INVALID_ARGUMENT"
    with factory.begin() as db:
        assert db.scalar(select(FixedIndicatorRun)) is None
        assert db.scalar(select(MarketDemand)) is None


@pytest.mark.parametrize("unavailable", ["missing", "unpublished", "reclaimed", "period"])
def test_history_unavailable_fails_without_jobs_or_fallback(mcp, monkeypatch, unavailable):
    client, token, factory = mcp
    version, _ = prepared(factory, frames=("M1",))
    arguments = query(version)
    with factory.begin() as db:
        if unavailable == "missing":
            arguments["instrument"] = "00000000-0000-0000-0000-000000000001"
        elif unavailable == "unpublished":
            arguments["instrument"] = create_version(db, identity().key, 0, 180000)
        elif unavailable == "reclaimed":
            db.add(HistoryReclamation(version_id=version, request_id="synthetic-retention"))
        else:
            arguments["timeframe"] = "H1"
        artifacts = list(db.scalars(select(HistoryArtifact.id)))
    forbid_market_io(monkeypatch)
    result = call(client, token, "indicators_calculate", arguments)
    assert result["isError"] and result["structuredContent"]["error"]["code"] == "DATA_UNAVAILABLE", result
    with factory.begin() as db:
        assert db.scalar(select(FixedIndicatorRun)) is None
        assert db.scalar(select(MarketDemand)) is None
        assert list(db.scalars(select(HistoryArtifact.id))) == artifacts


def test_new_publication_does_not_replace_requested_history(mcp, monkeypatch):
    client, token, factory = mcp
    version = history(factory, monkeypatch, count=30)
    first = page(client, token, query(version))
    run_id = first["indicators"][0]["calculation"]["run_id"]
    drain(run_id)
    before = page(client, token, query(version))
    newer = publish(factory, end=3600000)
    assert newer != version
    forbid_market_io(monkeypatch)
    after = page(client, token, query(version))
    for field in ("bars", "indicators", "input_manifest", "history_checksum"):
        assert after[field] == before[field]
    with factory.begin() as db:
        assert db.get(HistoryVersion, newer).status == "published"


def test_history_null_warmup_and_partial_final_bar_match_browser(mcp, monkeypatch):
    client, token, factory = mcp
    version, _ = prepared(factory, frames=("M1", "H4"))
    arguments = query(version, timeframe="H4")
    cold = page(client, token, arguments)
    drain(cold["indicators"][0]["calculation"]["run_id"])
    for provisional in (False, True):
        args = arguments | {"provisional": provisional}
        ready = page(client, token, args)
        browser = client.post("/api/charts/data", json=args | {"track_history": True}).json()
        assert ready["bars"] == browser["bars"]
        assert ready["indicators"] == browser["indicators"]
        assert not ready["bars"][-1]["coverage_complete"]
        assert all(v["value"] is None for s in ready["indicators"][0]["series"] for v in s["values"])
        assert all(not dep["initialized"] for dep in ready["indicators"][0]["dependencies"])
    cold = page(client, token, query(version))
    drain(cold["indicators"][0]["calculation"]["run_id"])
    warmup = page(client, token, query(version))["indicators"][0]
    assert warmup["calculation"]["visible_complete"]
    assert warmup["calculation"]["status"] == "complete"
    assert all(v["value"] is None for s in warmup["series"] for v in s["values"])
    assert all(not dep["initialized"] for dep in warmup["dependencies"])


def test_history_r1_script_exercises_real_protocol_without_exposing_token(mcp, monkeypatch, tmp_path):
    import importlib.util
    from io import BytesIO
    from pathlib import Path

    client, _, _ = mcp
    path = Path(__file__).resolve().parents[2] / "scripts/verify_history_indicators_mcp.py"
    spec = importlib.util.spec_from_file_location("verify_history_r1", path)
    verifier = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(verifier)
    verifier.seed(tmp_path)
    credentials = json.loads((tmp_path / "credentials.json").read_text())
    before = verifier.facts()

    class LocalOpener:
        def open(self, request, timeout):
            response = client.post("/mcp", headers=dict(request.header_items()),
                                   json=json.loads(request.data))
            assert response.status_code == 200, response.text
            return BytesIO(response.content)

    monkeypatch.setattr("urllib.request.build_opener", lambda *handlers: LocalOpener())
    for phase in ("cold", "partial", "ready"):
        verifier.verify(tmp_path, "http://127.0.0.1:8000", phase, tmp_path / (phase + ".json"))
        if phase != "ready":
            verifier.advance(tmp_path, finish=phase == "partial")
    assert verifier.facts() == before
    for phase in ("cold", "partial", "ready"):
        assert credentials["token"] not in (tmp_path / (phase + ".json")).read_text()
