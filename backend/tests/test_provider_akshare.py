"""Source truth validation, shared native content and SDK process deadlines."""

import subprocess
import sys
import time

import pytest
from alerts import provider_akshare as source
from alerts.config import settings
from alerts.history_mode_sources import dataset_identity
from alerts.market_contracts import NativeCandleBatch
from alerts.source_history_store import shared_native_page
from test_native_history_archive import day, stamp


def identity(symbol="SZSE:000001", frame="D1"):
    return source.collection_identity(dataset_identity("akshare", symbol, "native_periods", "none"), frame)


@pytest.mark.parametrize("patch", [{"open": "0"}, {"volume": "-1"}, {"close": "14"}])
def test_invalid_prices_volume_and_ranges_are_not_repaired(patch):
    record = {"date": "2024-01-02", "open": "10", "high": "12", "low": "9", "close": "11", "volume": "5", **patch}
    with pytest.raises(ValueError):
        source.parse_records(identity(), [record], start=stamp("2024-01-01"),
            end=stamp("2024-01-04"), observed_at=stamp("2024-01-04"))
    assert source.symbol_rules("HKEX:00700")["code"] == "00700"


def test_source_day_confirmation_uses_each_futures_row():
    data = [{"date": value, "open": "10", "high": "12", "low": "9", "close": "11", "volume": "2"}
            for value in ("2024-01-02", "2024-01-03")]
    rows = source.parse_records(identity("SHFE:RB0"), data, start=stamp("2024-01-01"),
        end=stamp("2024-01-04"), observed_at=stamp("2024-01-04"))
    assert all(row.complete for row in rows)


def test_identical_native_request_reuses_content_without_second_network(database):
    calls = []

    class Adapter:
        def native_page(self, identity, start, end):
            calls.append((start, end))
            return NativeCandleBatch(identity=identity, timeframe="D1", window_start=start, window_end=end,
                observed_at=end, checkpoint=end, rows=[day("2024-01-02")], result={"status": "data"},
                volume_kind="quantity", volume_unit="lots")

    kwargs = {"fresh_after": 0, "volume_kind": "quantity", "volume_unit": "lots"}
    first = shared_native_page(Adapter(), identity(), stamp("2024-01-01"), stamp("2024-01-04"), **kwargs)
    second = shared_native_page(Adapter(), identity(), stamp("2024-01-01"), stamp("2024-01-04"), **kwargs)
    assert first == second and len(calls) == 1


def test_deadline_kills_and_reaps_sdk_process_before_releasing_slot(database, monkeypatch):
    monkeypatch.setattr(settings, "akshare_enabled", True)
    real = subprocess.Popen
    children = []

    def slow(*args, **kwargs):
        child = real([sys.executable, "-c", "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(20)"], **kwargs)
        children.append(child)
        return child

    monkeypatch.setattr(source.subprocess, "Popen", slow)
    with pytest.raises(TimeoutError):
        source.invoke("stock_zh_a_hist", {}, deadline=time.monotonic() + 0.4)
    assert children and children[0].poll() is not None
