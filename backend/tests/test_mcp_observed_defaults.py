"""Personal analysis uses observed bars despite routine missing FX minutes."""

import pytest
from alerts.chart_indicators import calculate
from alerts.composite_definitions import first_use, save_mapping
from alerts.history_artifacts import artifact_tick, request_artifacts
from alerts.history_versions import create_version, import_page
from alerts.storage import HistoryVersion, MarketDemand
from sqlalchemy import select
from test_composite_aggregates import drain as aggregate
from test_composite_definitions import PROOF, prepare
from test_fixed_indicators import drain
from test_history_versions import Adapter
from test_market_contracts import batch, identity, minute
from test_native_mcp import call, rpc
from test_native_mcp import mcp as mcp

SPECS = [
    {"name": "EMA", "params": {"period": 3}},
    {"name": "RSI", "params": {"period": 3}},
    {"name": "ATR", "params": {"period": 3}},
    {"name": "SMA", "params": {"period": 3}},
    {"name": "MACD", "params": {"fast": 2, "slow": 4, "signal": 2}},
]


def sparse_series(factory, monkeypatch, kind):
    catalog = prepare(factory, monkeypatch)
    start = 1790024400000  # 2026-09-21 21:00 UTC, NY17 day boundary.
    end = start + 8 * 86400000
    rows = tuple(
        minute(start + i * 60000, open=str(1.1 + i / 1000000),
               close=str(1.1 + i / 1000000))
        for i in range(8 * 1440)
        if i % 1440 < 1425 and i // 1440 != 4
    )
    with factory.begin() as db:
        version = create_version(db, identity().key, start, end)
    import_page(Adapter([batch(window_start=start, window_end=end, checkpoint=end,
                               observed_at=end, rows=rows)]), version_id=version)
    with factory.begin() as db:
        request_artifacts(db, db.get(HistoryVersion, version), ["H4", "D1"])
    while artifact_tick(version):
        pass
    monkeypatch.setattr("alerts.series_access.now_ms", lambda: end + 3600000)
    if kind == "history":
        return version, {}
    monkeypatch.setattr("alerts.composite_definitions.now_ms", lambda: end + 3600000)
    with factory.begin() as db:
        mapping = save_mapping(db, identity().key, catalog, PROOF)
        composite = first_use(db, identity().key, mapping.id)
        ident, revision = composite.id, composite.active_revision_id
    for frame in ("H4", "D1"):
        aggregate(revision, frame)
    return ident, {"composite_revision_id": revision, "input_revision": 0}


@pytest.mark.parametrize("kind", ["history", "composite"])
@pytest.mark.parametrize("frame", ["H4", "D1"])
def test_default_mcp_uses_sparse_observed_sequence(mcp, monkeypatch, kind, frame):
    client, token, factory = mcp
    ident, binding = sparse_series(factory, monkeypatch, kind)
    args = dict(instrument=ident, series_kind=kind, timeframe=frame, limit=100,
                indicators=SPECS, **binding)
    def page(changes=None):
        result = call(client, token, "indicators_calculate", args | (changes or {}))
        assert not result["isError"], result
        return result["structuredContent"]["page"]

    observed = page()
    assert all(item["calculation"].get("input_policy") == "observed_display_v1"
               for item in observed["indicators"])
    for policy in ("observed_display_v1", "strict_confirmed_v1"):
        for item in page({"indicator_input_policy": policy})["indicators"]:
            drain(item["calculation"]["run_id"])
    observed = page()
    strict = page({"indicator_input_policy": "strict_confirmed_v1"})
    browser = client.post("/api/charts/data", json=args | {
        "indicator_input_policy": "observed_display_v1", "track_history": True,
        "provisional": False}).json()
    assert observed["bars"] == strict["bars"] == browser["bars"]
    assert observed["indicators"] == browser["indicators"]
    bars = observed["bars"]
    assert any(not bar["coverage_complete"] for bar in bars)
    assert any(b["start"] - a["end"] >= 86400000 for a, b in zip(bars, bars[1:]))
    for item, spec in zip(observed["indicators"], SPECS, strict=True):
        expected = calculate([{**bar, "complete": True, "gap_before": False}
                              for bar in bars], spec)
        for actual, reference in zip(item["series"], expected["series"], strict=True):
            assert [v["value"] for v in actual["values"]] == pytest.approx(
                [v["value"] for v in reference["values"]], abs=1e-8)
        assert item["calculation"]["visible_complete"]
        assert item["calculation"]["value_status"] == "ready"
        assert all(s["values"][-1]["value"] is not None for s in item["series"])
    if frame == "D1":
        assert all(v["value"] is None for item in strict["indicators"]
                   for s in item["series"] for v in s["values"])
    with factory.begin() as db:
        assert db.scalar(select(MarketDemand)) is None


def test_policy_discovery_describes_observed_default(mcp):
    client, token, _ = mcp
    tools = rpc(client, token, "tools/list").json()["result"]["tools"]
    schema = next(t for t in tools if t["name"] == "indicators_calculate")["inputSchema"]
    assert schema["properties"]["indicator_input_policy"]["default"] == "observed_display_v1"
    policy = call(client, token, "indicators_list")["structuredContent"]["policy"]
    assert "observed_display_v1" in policy and "strict_confirmed_v1" in policy
