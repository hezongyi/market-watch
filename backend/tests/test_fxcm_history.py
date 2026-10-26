"""Offline FXCM contracts use recorded BID data; no broker login."""

import json
import os
import time
from pathlib import Path

import pytest
from alerts import fxcm_history as fxcm
from alerts.config import settings
from alerts.market_contracts import MarketRequestError
from alerts.storage import Preference
from test_market_contracts import identity


@pytest.fixture
def fxcm_config(tmp_path, monkeypatch):
    secret = tmp_path / "credentials.json"
    secret.write_text(json.dumps({"username": "fixture-demo", "password": "fixture-only"}))
    secret.chmod(0o600)
    helper = tmp_path / "helper"
    helper.touch()
    for name, value in {"fxcm_enabled": True, "fxcm_credentials_file": str(secret),
                        "fxcm_helper_path": str(helper), "fxcm_sdk_path": str(tmp_path)}.items():
        monkeypatch.setattr(settings, name, value)
    return secret, helper


def recorded(symbol="EUR/USD", frame="m1", page=0):
    path = Path(__file__).resolve().parents[2] / "docs/verification/fxcm/evidence/native-history-samples.jsonl"
    rows = [json.loads(line) for line in path.read_text().splitlines()]
    return [{"kind": "candle", "time": row["time"],
             **dict(zip(("open", "high", "low", "close"), row["bid"])),
             "volume": row["volume"]} for row in rows
            if row.get("kind") == "candle" and (row.get("symbol"), row.get("frame"), row.get("page")) == (symbol, frame, page)]


def fxcm_identity():
    return identity(source="fxcm", channel="forexconnect", environment="demo",
                    account_scope=fxcm.account_scope())


@pytest.mark.parametrize("symbol,digits", [("EUR/USD", 5), ("XAU/USD", 2)])
def test_recorded_real_bid_precision_sorting_and_exclusive_pages(monkeypatch, symbol, digits):
    adapter = fxcm.FxcmHistory(clock=lambda: 1800000000000)
    pages = [recorded(symbol, page=p) for p in (0, 1)]
    monkeypatch.setattr(adapter, "_request", lambda *a, **k: pages.pop(0))
    first = adapter.bars(symbol, "M1", 0, 1800000000000, digits)
    second = adapter.bars(symbol, "M1", 0, first[0]["start"], digits)
    assert len(first) == len(second) == 300
    assert second[-1]["start"] < first[0]["start"]
    assert first == sorted(first, key=lambda row: row["start"])
    assert all(len(row["close"].split(".")[1]) == digits for row in first + second)
    assert first[-1]["close"] == recorded(symbol)[-1]["close"]


@pytest.mark.parametrize("frame", ["M1", "D1"])
def test_snapshot_inclusive_boundary_is_clipped_to_requested_range(monkeypatch, frame):
    # Real XAU/USD D1 pagination returned a bar exactly at the requested `to`.
    # SDK snapshot bounds must not become an invalid-page error or an overlap.
    from datetime import UTC, datetime
    rows = [{**recorded()[0], "time": stamp} for stamp in (
        "2026-09-25T21:00:00Z", "2026-09-26T21:00:00Z", "2026-09-27T21:00:00Z")]
    start = fxcm.ms(datetime(2026, 9, 26, 21, tzinfo=UTC))
    end = fxcm.ms(datetime(2026, 9, 27, 21, tzinfo=UTC))
    adapter = fxcm.FxcmHistory(clock=lambda: 1800000000000)
    monkeypatch.setattr(adapter, "_request", lambda *a, **k: rows)
    assert [row["start"] for row in adapter.bars("EUR/USD", frame, start, end, 5)] == [start]


@pytest.mark.parametrize("patch", [{"open": "NaN"}, {"close": "1e2"}, {"high": "0"},
    {"low": "1000000000000000000000"}, {"volume": True}, {"volume": -1},
    {"close": "1.123456"}, {"time": "2026-10-23T16:00:00"}, {"time": None}])
def test_malformed_prices_timestamps_and_volume_rejected(monkeypatch, patch):
    adapter = fxcm.FxcmHistory(clock=lambda: 1800000000000)
    monkeypatch.setattr(adapter, "_request", lambda *a, **k: [{**recorded()[0], **patch}])
    with pytest.raises(ValueError):
        adapter.bars("EUR/USD", "M1", 0, 1800000000000, 5)


def test_managed_page_keeps_elapsed_distinct_and_advances_empty_success(fxcm_config, monkeypatch):
    from alerts import provider_fxcm
    monkeypatch.setattr(provider_fxcm, "symbol_metadata", lambda _: {"precision": 5})
    adapter = fxcm.FxcmHistory(clock=lambda: 90000)
    monkeypatch.setattr(adapter, "bars", lambda *a, **k: [
        {"start": at, "open": "1.10", "high": "1.12", "low": "1.09",
         "close": "1.11", "volume": "3"} for at in (0, 60000)])
    page = adapter.page(fxcm_identity(), 0, 120000)
    assert [row.complete for row in page.rows] == [True, False]
    assert page.volume_kind == "tick_count" and page.checkpoint == 120000
    monkeypatch.setattr(adapter, "bars", lambda *a, **k: [])
    page = adapter.page(fxcm_identity(), 0, 120000)
    assert page.result.status == "empty_success" and page.checkpoint == 120000
    with pytest.raises(ValueError):
        adapter.page(fxcm_identity().model_copy(update={"account_scope": "sha256:" + "a" * 64}), 0, 60000)


@pytest.mark.parametrize("empty", [True, False], ids=["weekend-empty", "full-300-minutes"])
def test_managed_snapshot_handles_empty_windows_and_inclusive_capacity(fxcm_config, monkeypatch, empty):
    from datetime import UTC, datetime

    from alerts import provider_fxcm
    from alerts.market_contracts import RequestResult
    monkeypatch.setattr(provider_fxcm, "symbol_metadata", lambda _: {"precision": 5})
    start = fxcm.ms(datetime(2026, 10, 24, tzinfo=UTC))
    end = start + 300 * 60000
    base = recorded()[0]
    # Real SDK rejects a fully empty bounded interval, but succeeds when given
    # a cutoff and capacity. Its cutoff can include a bar exactly at `to`.
    stamps = ([start - (300 - i) * 60000 for i in range(300)] if empty else
              [start + i * 60000 for i in range(301)])
    calls = []
    def snapshot(command, **kwargs):
        calls.append(command)
        _, left, right, count = command.splitlines()[3].split()
        left = round((float(left) - 25569) * 86400000)
        right = round((float(right) - 25569) * 86400000)
        if empty and left >= start:
            raise MarketRequestError(RequestResult(status="unavailable"))
        chosen = [at for at in stamps if left <= at <= right][-int(count):]
        return [{**base, "time": datetime.fromtimestamp(at / 1000, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")}
                for at in chosen]
    adapter = fxcm.FxcmHistory(clock=lambda: 1800000000000)
    monkeypatch.setattr(adapter, "_request", snapshot)
    page = adapter.page(fxcm_identity(), start, end)
    assert len(calls) == 1
    assert page.result.status == ("empty_success" if empty else "data")
    assert page.checkpoint == end
    assert [row.timestamp for row in page.rows] == ([] if empty else list(range(start, end, 60000)))


def test_private_demo_only_credentials_and_zero_demand(fxcm_config, monkeypatch):
    secret, _ = fxcm_config
    monkeypatch.setattr(fxcm.subprocess, "Popen", lambda *a, **k: pytest.fail("unexpected login"))
    adapter = fxcm.FxcmHistory()
    assert fxcm.configured() and adapter.process is None
    assert "fixture-demo" not in fxcm.account_scope()
    secret.chmod(0o644)
    assert not fxcm.configured()
    secret.chmod(0o600)
    secret.write_text(json.dumps({"username": "fixture", "password": "fixture", "connection": "live"}))
    with pytest.raises(ValueError, match="凭据"):
        fxcm.credentials()


def test_auth_error_is_safe_and_shared_cooldown(database):
    read, write = os.pipe()
    os.write(write, b'{"kind":"error","code":"auth","message":"secret"}\n')
    os.close(write)
    adapter = fxcm.FxcmHistory()
    class Process:
        stdout = os.fdopen(read, "rb", buffering=0)
    adapter.process = Process()
    try:
        with pytest.raises(MarketRequestError) as error:
            adapter._line(time.monotonic() + 1)
        assert error.value.result.status == "unauthorized"
        assert "secret" not in str(error.value)
        with database() as db:
            assert db.get(Preference, "upstream_slots:fxcm").value["cooldown_until"] > fxcm.now_ms() + 299000
    finally:
        adapter.process.stdout.close()
        adapter.process = None


def test_cancellation_terminates_child_and_removes_private_directory(database, fxcm_config):
    _, helper = fxcm_config
    helper.write_text("#!/usr/bin/python3\nimport sys, time\nfor _ in range(4): sys.stdin.readline()\nprint('{\"kind\":\"ready\"}', flush=True)\nsys.stdin.readline()\ntime.sleep(30)\n")
    helper.chmod(0o700)
    calls = []
    def cancel():
        calls.append(1)
        if len(calls) > 4:
            raise TimeoutError("cancelled")
    adapter = fxcm.FxcmHistory(cancel=cancel)
    with pytest.raises(TimeoutError, match="cancelled"):
        adapter.catalog()
    assert adapter.process is None and adapter.directory is None


def test_fxcm_one_shared_source_slot_covers_chart_and_history(database, monkeypatch):
    monkeypatch.setattr("alerts.market_resources.now_ms", lambda: 100000)
    from alerts.market_resources import acquire, release
    token = acquire("fxcm", "chart", 100000)
    assert token and acquire("fxcm", "history", 100000) is None
    release("fxcm", token)
    assert acquire("fxcm", "history", 100999) is None
    assert acquire("fxcm", "history", 101000)


def test_fxcm_long_login_paces_other_process_from_completion(database, monkeypatch):
    from alerts.market_resources import acquire, release
    token = acquire("fxcm", "chart", 100000)
    assert token
    monkeypatch.setattr("alerts.market_resources.now_ms", lambda: 145000)
    release("fxcm", token)
    assert acquire("fxcm", "history", 145000) is None
    assert acquire("fxcm", "history", 145999) is None
    assert acquire("fxcm", "history", 146000)


def test_fxcm_cancellation_keeps_shared_slot_until_child_closed(database, fxcm_config, monkeypatch):
    from alerts.market_resources import acquire
    adapter = fxcm.FxcmHistory()
    cleaned = []
    def fail_start(*args):
        raise TimeoutError("cancelled")
    def close():
        assert acquire("fxcm", "history", fxcm.now_ms() + 10000) is None
        cleaned.append(True)
    monkeypatch.setattr(adapter, "_start", fail_start)
    monkeypatch.setattr(adapter, "close", close)
    with pytest.raises(TimeoutError, match="cancelled"):
        adapter.catalog()
    assert cleaned == [True]
    with database() as db:
        assert db.get(Preference, "upstream_slots:fxcm").value["active"] == []
