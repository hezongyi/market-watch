"""A0 replay at actual ProviderBar commit -> shared delivery boundary."""
from types import SimpleNamespace

import pytest
from alerts import market_stream as stream, provider_cache as cache
from alerts.chart_api import DataQuery
from alerts.provider_acceptance import receipts
from test_provider_cache import META, seed
from test_provider_postgres import provider_pg


@pytest.mark.parametrize("change, should_reset", [
    ({"complete": True}, False),
    ({"close": "2.5"}, True),
    ({"volume": "6"}, True),
])
def test_previous_minute_requires_reset_only_for_native_change(provider_pg, monkeypatch,
                                                              change, should_reset):
    factory, _ = provider_pg
    clock = [10000000]
    monkeypatch.setattr(cache, "now_ms", lambda: clock[0])
    first = dict(start=60000, end=120000, chart_time=60000, open="1", high="3", low="0",
                 close="2", volume="5", complete=False)
    tail = {**first, "start": 120000, "chart_time": 120000, "end": 180000}
    key = seed(META, "M1", 180000, {"bars": [first, tail], "history_boundary": False})
    accepted = cache.snapshot(key, 180000, 2)
    clock[0] += 1000
    seed(META, "M1", 120000, {"bars": [{**first, **change}], "history_boundary": False})
    state = dict(history_accepted=True, historical=False, loaded_after=60000,
                 loaded_before=120000, cursor=120000, observed_at=accepted["as_of"],
                 provider_acceptance=receipts(accepted["bars"]))
    query = DataQuery(instrument=META["id"], series_kind="provider", timeframe="M1")
    with factory.begin() as db:
        event = stream.delivery(db, SimpleNamespace(query=query.model_dump(), identity={"dataset_id": key}),
            SimpleNamespace(listener="native", generation=1, state=state),
            {"type": "bars", **cache.snapshot(key, 180000, 2)}, {})
    assert (event["type"] == "reset") == should_reset, (
        f"native unchanged confirmation must not clear the chart: {event}")


def test_commit_observation_distinguishes_confirmation_price_and_volume(provider_pg, monkeypatch, caplog):
    import json
    import logging

    clock = [10000000]
    monkeypatch.setattr(cache, "now_ms", lambda: clock[0])
    monkeypatch.setattr(cache.settings, "platform_native_update_diagnostics", True)
    caplog.set_level(logging.INFO, logger="alerts.provider_cache")
    row = dict(start=60000, end=120000, chart_time=60000, open="1", high="3", low="0",
               close="2", volume="5", complete=False)
    seed(META, "M1", row["end"], {"bars": [row], "history_boundary": False})
    for change in ({"complete": True}, {"close": "2.5"}, {"volume": "6"}, {}):
        clock[0] += 1000
        row = {**row, **change}
        seed(META, "M1", row["end"], {"bars": [row], "history_boundary": False})
    reports = [json.loads(record.message.split(" ", 1)[1]) for record in caplog.records
               if record.message.startswith("provider-change-summary ")]
    assert len(reports) == 5, "each committed source page needs one bounded summary"
    assert [report["counts"] for report in reports] == [
        {"inserted": 1}, {"metadata": 1}, {"ohlc": 1}, {"volume": 1}, {"unchanged": 1}]
    assert reports[3]["volume_relative_buckets"] == {"0.1_to_1": 1}
    assert reports[1]["confirmation_delay_buckets"] == {"gt_60s": 1}
    assert all("CACHE_TEST" not in str(report) for report in reports), "no source symbol or account in logs"


@pytest.mark.parametrize("native", [False, True])
@pytest.mark.parametrize("indicator", ["SUPERTREND_PINE_V1", "SWING_SR_V1"])
@pytest.mark.parametrize("inside_snapshot", [False, True])
def test_provider_study_page_uses_the_same_frozen_prices_during_repair(provider_pg, monkeypatch,
                                                                   native, indicator, inside_snapshot):
    from alerts import provider_chart as upstream

    clock = [10000000]
    monkeypatch.setattr(cache, "now_ms", lambda: clock[0])
    monkeypatch.setattr(upstream, "metadata", lambda *args, **kwargs: META)
    rows = [dict(start=index * 60000, end=(index + 1) * 60000, chart_time=index * 60000,
                 open="2", high="3", low="1", close="2", complete=True)
            for index in range(1, 31)]
    seed(META, "M1", rows[-1]["end"], {"bars": rows, "history_boundary": True}, latest=True)
    query = DataQuery(instrument=META["id"], series_kind="provider", timeframe="M1", limit=5,
        before=rows[-1]["end"], calculation_origin=60000,
        indicators=[{"name": indicator,
                     "params": {"period": 2} if indicator == "SUPERTREND_PINE_V1" else {}}])
    if native:
        from alerts.chart_api import NativeHistory
        query = query.model_copy(update={"native_history": NativeHistory(chart_count=1, screen_bars=160)})
    original = cache.data(query)
    real_read = cache.read
    real_native_read = cache.native_read
    repairs = []

    def repair():
        if not repairs:
            repairs.append(True)
            clock[0] += 1000
            seed(META, "M1", rows[-1]["end"], {"bars": [{**row, "high": "30", "close": "29"}
                for row in rows], "history_boundary": True}, latest=True)

    def repair_after_window_is_frozen(*args, **kwargs):
        page = (real_native_read if native else real_read)(*args, **kwargs)
        repair()
        return page

    if inside_snapshot:
        from sqlalchemy import event
        def repair_after_window_select(conn, cursor, statement, params, context, many):
            if statement.lstrip().upper().startswith("SELECT") and "provider_bars.payload" in statement:
                repair()
        event.listen(provider_pg[1], "after_cursor_execute", repair_after_window_select)
        try:
            accepted = cache.data(query)
        finally:
            event.remove(provider_pg[1], "after_cursor_execute", repair_after_window_select)
    else:
        monkeypatch.setattr(cache, "native_read" if native else "read", repair_after_window_is_frozen)
        accepted = cache.data(query)
        monkeypatch.setattr(cache, "native_read" if native else "read", real_native_read if native else real_read)
    current = cache.data(query)
    assert repairs
    assert accepted["bars"] == original["bars"]
    assert accepted["cache_revision"] == original["cache_revision"] < current["cache_revision"]
    assert accepted["indicators"] == original["indicators"], "old price token cannot describe new recursive input"
    assert current["indicators"] != original["indicators"]


def test_study_prefix_budget_rejects_without_truncating_the_origin(provider_pg, monkeypatch):
    from alerts import provider_chart as upstream
    from alerts.provider_history_policy import CapacityExceeded

    monkeypatch.setattr(cache, "now_ms", lambda: 10000000)
    monkeypatch.setattr(upstream, "metadata", lambda *args, **kwargs: META)
    rows = [dict(start=index * 60000, end=(index + 1) * 60000, chart_time=index * 60000,
                 open="2", high="3", low="1", close="2", complete=True)
            for index in range(1, 31)]
    seed(META, "M1", rows[-1]["end"], {"bars": rows, "history_boundary": True}, latest=True)
    query = DataQuery(instrument=META["id"], series_kind="provider", timeframe="M1", limit=5,
        before=rows[-1]["end"], calculation_origin=60000,
        indicators=[{"name": "SUPERTREND_PINE_V1", "params": {"period": 2}}])
    monkeypatch.setattr(cache, "capacity", lambda: 20)
    with pytest.raises(CapacityExceeded):
        cache.data(query)
    monkeypatch.setattr(cache, "capacity", lambda: 30)
    assert cache.data(query)["calculation_origin"] == 60000


def test_diagnostics_record_only_successfully_committed_changes(provider_pg, monkeypatch, caplog):
    import json
    import logging
    from alerts.storage import ProviderBar

    clock = [10000000]
    monkeypatch.setattr(cache, "now_ms", lambda: clock[0])
    monkeypatch.setattr(cache.settings, "platform_native_update_diagnostics", True)
    caplog.set_level(logging.INFO, logger="alerts.provider_cache")
    row = dict(start=60000, end=120000, chart_time=60000, open="1", high="3", low="0",
               close="2", volume="5", complete=True)
    key = seed(META, "M1", 120000, {"bars": [row], "history_boundary": False})
    caplog.clear()
    # A bad coverage proof rolls the update back, including its observation.
    lease = cache.claim(key)
    try:
        with pytest.raises(ValueError):
            cache.commit_page(key, lease, {"bars": [{**row, "close": "2.5"}],
                "history_boundary": False, "coverage": [[60000, 180000]]}, 120000, clock[0] + 1000)
    finally:
        cache.release(key, lease)
    assert not [record for record in caplog.records if record.message.startswith("provider-change-summary")]
    with provider_pg[0].begin() as db:
        assert db.get(ProviderBar, (key, 60000)).payload == row
    # Refused unconfirmed replacement and authoritative deletion are distinct.
    seed(META, "M1", 120000, {"bars": [{**row, "complete": False}], "history_boundary": False})
    clock[0] += 2000
    seed(META, "M1", 120000, {"bars": [], "history_boundary": False,
         "revalidation": True, "coverage": [[60000, 120000]]})
    reports = [json.loads(record.message.split(" ", 1)[1]) for record in caplog.records
               if record.message.startswith("provider-change-summary ")]
    assert [report["counts"] for report in reports] == [{"rejected": 1}, {"deleted": 1}]
    assert cache.snapshot(key, 120000, 1)["bars"] == []


def test_a0_fifteen_m1_boundaries_baseline(provider_pg, monkeypatch, caplog):
    """Report the old strategy; deliberately no claim about rendered native paint."""
    import json
    import logging
    import time
    from collections import Counter

    clock = [120000]
    monkeypatch.setattr(cache, "now_ms", lambda: clock[0])
    monkeypatch.setattr(cache.settings, "platform_native_update_diagnostics", True)
    caplog.set_level(logging.INFO, logger="alerts.provider_cache")
    row = dict(start=60000, end=120000, chart_time=60000, open="1", high="3", low="0",
               close="2", volume="5", complete=False)
    key = seed(META, "M1", 120000, {"bars": [row], "history_boundary": False})
    state = dict(history_accepted=True, historical=False, loaded_after=60000,
                 loaded_before=60000, cursor=60000, observed_at=clock[0])
    task = SimpleNamespace(query=DataQuery(instrument=META["id"], series_kind="provider",
        timeframe="M1").model_dump(), identity={"dataset_id": key})
    sub = SimpleNamespace(listener="native", generation=1, state=state)
    cursors, events, durations = {}, Counter(), []
    for _ in range(15):
        clock[0] += 60000
        next_row = {**row, "start": row["end"], "end": row["end"] + 60000,
                    "chart_time": row["end"]}
        seed(META, "M1", next_row["end"], {"bars": [{**row, "complete": True}, next_row],
             "history_boundary": False})
        for _ in range(2):
            begin = time.perf_counter()
            page = cache.snapshot(key, next_row["end"], 100)
            with provider_pg[0].begin() as db:
                event = stream.delivery(db, task, sub, {"type": "bars", **page}, cursors)
            durations.append((time.perf_counter() - begin) * 1000)
            events[event.get("reason", event["type"])] += 1
            if event["type"] == "reset":
                # Model ordinary recovery accepting the whole current history.
                sub.state = {**sub.state, "loaded_before": next_row["start"],
                    "cursor": next_row["chart_time"], "observed_at": page["as_of"]}
                cursors.clear()
        row = next_row
    source = Counter()
    for record in caplog.records:
        if record.message.startswith("provider-change-summary "):
            source.update(json.loads(record.message.split(" ", 1)[1])["counts"])
    ordered = sorted(durations)
    report = {"schema": 1, "scenario": "controlled_same_value_confirmation_then_append",
        "native_render_verified": False, "strategy": "v1.25.3_delivery",
        "m1_boundaries": 15, "consumer_observations": sum(events.values()),
        "source_commit_bar_classifications": dict(source), "delivery_results": dict(events),
        "snapshot_delivery_ms": {"p50": round(ordered[len(ordered)//2], 3),
            "p95": round(ordered[int(len(ordered)*.95)-1], 3)},
        "production_frequency_inferred": False}
    assert source == {"inserted": 16, "metadata": 15}
    assert sum(events.values()) == 30
    print("NATIVE_UPDATE_A0_REPORT=" + json.dumps(report, sort_keys=True))
