import uuid
from datetime import datetime
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest
from alerts import (
    briefing_sections as sections,
)
from alerts import (
    briefing_service as service,
)
from alerts import (
    briefing_worker as worker,
)
from alerts.storage import AdvancedPreference, BriefingPlan, BriefingReport, Notification
from sqlalchemy import select


def at(text):
    return int(datetime.fromisoformat(text).timestamp() * 1000)


NOW = at("2026-11-17T08:00:00+08:00")


def seed(db):
    db.add(
        AdvancedPreference(
            id="watchlists",
            kind="setting",
            name="mw.watchlists.v1",
            tool="",
            revision=7,
            content={
                "value": {
                    "lists": [
                        {
                            "id": "fx",
                            "title": "外汇",
                            "symbols": ["EURUSD", "EURUSD", "MWP:EURUSD"],
                        },
                        {"id": "gold", "title": "黄金", "symbols": ["XAUUSD"]},
                    ]
                }
            },
        )
    )
    db.flush()
    return service.save_plan(db, enabled=True, group_ids=["fx"], revision=0, at=NOW - 1)


def input_value(ticker="EURUSD", latest="102.1", previous="100"):
    return {
        "ticker": ticker,
        "status": "ok",
        "rows": [
            {
                "start": NOW - 3 * 86400000,
                "end": NOW - 2 * 86400000,
                "trading_date": "2026-11-14",
                "open": previous,
                "high": previous,
                "low": previous,
                "close": previous,
                "complete": True,
            },
            {
                "start": NOW - 2 * 86400000,
                "end": NOW - 86400000,
                "trading_date": "2026-11-15",
                "open": latest,
                "high": latest,
                "low": latest,
                "close": latest,
                "complete": True,
            },
        ],
    }


def test_next_future_shanghai_0800_and_weekend():
    for source in [
        "2026-11-17T00:00:00+00:00",
        "2026-11-16T19:00:00-05:00",
        "2026-11-17T08:00:00+08:00",
    ]:
        assert service.next_run(at(source)) == NOW + 86400000
    assert service.next_run(NOW - 1) == NOW
    assert (
        datetime.fromtimestamp(
            service.next_run(at("2026-11-20T08:00:00+08:00")) / 1000, ZoneInfo("Asia/Shanghai")
        ).weekday()
        == 5
    )


def test_revision_snapshot_dynamic_groups_and_identity(database):
    with database.begin() as db:
        view = seed(db)
        assert view["next_run_at"] == NOW
        with pytest.raises(service.Conflict):
            service.save_plan(db, enabled=True, group_ids=["gold"], revision=0, at=NOW)
        frozen = service.freeze(db, db.get(BriefingPlan, service.PLAN_ID))
        assert frozen["members"] == ["EURUSD", "MWP:EURUSD"]
        assert frozen["group_revision"] == 7
        row = db.get(AdvancedPreference, "watchlists")
        row.content = {"value": {"lists": [{"id": "fx", "title": "New", "symbols": ["XAUUSD"]}]}}
        assert service.freeze(db, db.get(BriefingPlan, service.PLAN_ID))["members"] == ["XAUUSD"]
        assert frozen["members"] == ["EURUSD", "MWP:EURUSD"]


def test_due_preview_unique_skip_and_no_early_catchup(database):
    request = str(uuid.uuid4())
    with database.begin() as db:
        seed(db)
        assert service.due(db, at=NOW - 1) is None
        first = service.due(db, at=NOW + 1000)
        assert first.cutoff_at == NOW
        db.flush()
        assert service.due(db, at=NOW + 2000) is None
        preview = service.preview(db, request, at=NOW + 2000)
        assert service.preview(db, request, at=NOW + 3000)["id"] == preview["id"]
        assert db.scalars(select(BriefingReport)).all().__len__() == 2
        plan = db.get(BriefingPlan, service.PLAN_ID)
        plan.next_run_at = NOW - 3 * 86400000
        skipped = service.due(db, at=NOW + 86400000 + 3 * 3600000)
        assert skipped.status == "skipped"
        assert skipped.cutoff_at == NOW + 86400000
        assert list(db.scalars(select(Notification))) == []


def test_confirmed_decimal_changes_and_invalid_ohlc():
    data = [
        input_value(latest="102.123456789123", previous="100.123456789123"),
        input_value("fall", latest="90"),
        input_value("flat", latest="100"),
        input_value("bad", previous="0"),
    ]
    result = sections.daily_change(data)
    assert result["items"][0]["change"] == "2.000000000000"
    assert Decimal(result["items"][1]["change_pct"]) == -10
    assert result["items"][2]["change_pct"] == "0"
    assert result["items"][3]["status"] == "source_error"
    assert result["coverage"] == {"ok": 3, "source_error": 1}


def test_section_failure_isolated(monkeypatch):
    def broken(*_):
        raise RuntimeError("test")

    monkeypatch.setitem(sections.REGISTRY, "test", broken)
    result = sections.compute(
        [{"id": "test", "version": 1}, {"id": "daily_change", "version": 1}], [input_value()]
    )
    assert result[0]["kind"] == "error"
    assert result[1]["coverage"]["ok"] == 1


def test_claim_publish_attempt_fencing_and_preview_no_notification(database, monkeypatch):
    monkeypatch.setattr(worker, "now_ms", lambda: NOW)
    with database.begin() as db:
        seed(db)
    task = worker.claim(at=NOW)
    assert task and task["attempt"] == 1
    assert worker.claim(at=NOW + 1000) is None
    status, body = worker.generate(task, reader=lambda ticker, *a, **kw: input_value(ticker))
    assert status == "ready"
    assert not worker.publish({**task, "attempt": 0}, status, body, at=NOW)
    assert worker.publish(task, status, body, at=NOW)
    assert not worker.publish(task, status, body, at=NOW)
    with database.begin() as db:
        notes = list(db.scalars(select(Notification)))
        assert len(notes) == 1 and notes[0].kind == "briefing"
        row = db.get(BriefingReport, task["id"])
        assert row.body == body
        service.preview(db, str(uuid.uuid4()), at=NOW)
    preview = worker.claim(at=NOW)
    status, body = worker.generate(preview, reader=lambda ticker, *a, **kw: input_value(ticker))
    worker.publish(preview, status, body, at=NOW)
    with database.begin() as db:
        assert len(list(db.scalars(select(Notification)))) == 1


def test_pause_missing_and_empty_groups(database):
    with database.begin() as db:
        seed(db)
        db.get(AdvancedPreference, "watchlists").content = {"value": {"lists": []}}
        plan = db.get(BriefingPlan, service.PLAN_ID)
        snap = service.freeze(db, plan)
        assert snap["members"] == [] and snap["missing_groups"] == ["fx"]
        service.save_plan(db, enabled=False, group_ids=[], revision=1, at=NOW)
        assert service.due(db, at=NOW + 86400000) is None


def test_restart_preserves_cutoff_and_members(database, monkeypatch):
    with database.begin() as db:
        seed(db)
    task = worker.claim(at=NOW)
    with database.begin() as db:
        db.get(AdvancedPreference, "watchlists").content = {"value": {"lists": []}}
    recovered = worker.claim(at=NOW + worker.BUDGET_MS + 1)
    assert recovered["id"] == task["id"] and recovered["attempt"] == 2
    assert recovered["cutoff"] == task["cutoff"] and recovered["snapshot"] == task["snapshot"]
    assert not worker.publish(task, "ready", {}, at=NOW)


def test_provider_confirmed_cutoff_and_history_lane(database, monkeypatch):
    from alerts import briefing_inputs, provider_cache, provider_chart
    from alerts.storage import ProviderBar, ProviderDataset

    meta = {
        "symbol": "EUR/USD",
        "name": "Euro",
        "source": "dukascopy",
        "basis": "bid",
        "calendar": "dukascopy_native_utc",
        "frames": ["D1"],
    }
    monkeypatch.setattr(provider_chart, "metadata", lambda *a, **kw: meta)
    key = provider_cache.identity(meta, "D1")
    with database.begin() as db:
        db.add(
            ProviderDataset(
                id=key,
                source="dukascopy",
                symbol="EUR/USD",
                timeframe="D1",
                metadata_json=meta,
                coverage=[],
                revision=0,
            )
        )
        db.flush()
        for i, (end, complete) in enumerate(
            [(NOW - 86400000, True), (NOW, True), (NOW + 86400000, True), (NOW - 1, False)]
        ):
            row = input_value()["rows"][0]
            row.update(start=end - 86400000, end=end, complete=complete)
            db.add(
                ProviderBar(
                    dataset_id=key,
                    start=NOW - (i + 1) * 86400000,
                    chart_time=NOW - (i + 1) * 86400000,
                    complete=complete,
                    payload=row,
                    observed_at=NOW,
                )
            )
    calls = []
    monkeypatch.setattr(provider_cache, "ensure", lambda *_: key)
    monkeypatch.setattr(provider_cache, "fetch_page", lambda *a, **kw: calls.append(kw))
    result = briefing_inputs.read("MWP:DUKA:" + "a" * 32, NOW, deadline=1e12, refresh=True)
    assert len(result["rows"]) == 2 and all(x["end"] <= NOW for x in result["rows"])
    assert calls[0]["kind"] == "history" and calls[0]["revalidate"]


def test_cache_first_and_total_budget(monkeypatch):
    import threading
    import time

    monkeypatch.setattr(worker, "now_ms", lambda: NOW)
    task = {
        "created_at": NOW,
        "attempt": 1,
        "cutoff": NOW,
        "snapshot": {
            "members": ["MWP:a", "MWP:b", "MWP:c"],
            "sections": [{"id": "daily_change", "version": 1}],
            "groups": [{"id": "fx"}],
            "missing_groups": [],
        },
    }
    calls = []

    def cached(ticker, *_, refresh=False, **kw):
        calls.append((ticker, refresh))
        return input_value(ticker)

    status, _ = worker.generate(task, reader=cached)
    assert status == "ready" and len(calls) == 3 and not any(x[1] for x in calls)
    monkeypatch.setattr(worker, "BUDGET_MS", 150)
    active = [0, 0]
    lock = threading.Lock()
    ended = threading.Event()

    def slow(ticker, *_, refresh=False, **kw):
        if not refresh:
            return {"ticker": ticker, "status": "not_updated", "rows": []}
        with lock:
            active[0] += 1
            active[1] = max(active)
        time.sleep(0.4)
        with lock:
            active[0] -= 1
            if not active[0]:
                ended.set()
        return input_value(ticker)

    started = time.monotonic()
    status, body = worker.generate(task, reader=slow)
    assert time.monotonic() - started < 0.35 and status == "failed"
    assert active[1] <= 2 and len(body["sections"][0]["items"]) == 3
    assert ended.wait(2), "Fixture threads must finish before database teardown"


def test_verified_native_calendar_weekend_dst_and_stale():
    from alerts.briefing_freshness import assess, expected_end

    meta = {"source": "dukascopy", "symbol": "EUR/USD", "calendar": "dukascopy_native_utc"}
    for cutoff, wanted in [
        ("2026-11-17T00:00:00+00:00", "2026-11-17T00:00:00+00:00"),
        ("2026-11-15T00:00:00+00:00", "2026-11-14T00:00:00+00:00"),
        ("2026-11-01T00:00:00+00:00", "2026-10-31T00:00:00+00:00"),
    ]:
        end, _ = expected_end(meta, at(cutoff))
        assert end == at(wanted)
        rows = input_value()["rows"]
        rows[-1]["end"] = end
        assert assess(meta, rows, at(cutoff), "provider")[0] == "ok"
        rows[-1]["end"] = end - 86400000
        assert assess(meta, rows, at(cutoff), "provider")[0] == "not_updated"
    assert expected_end({**meta, "symbol": "USD/XYZ"}, NOW)[0] is None
    assert assess(meta, input_value()["rows"], NOW, "history")[2] == "固定历史"


def test_dated_source_sessions_require_current_evidence():
    from alerts.briefing_freshness import expected_end

    end = NOW - 4 * 3600000
    meta = {
        "source": "yahoo",
        "symbol": "AAPL",
        "sparkline_sessions": {"2026-11-16": {"start": end - 23400000, "end": end}},
        "session_evidence_at": NOW,
    }
    assert expected_end(meta, NOW)[0] == end
    meta["session_evidence_at"] = NOW - 86400000
    assert expected_end(meta, NOW)[0] is None


def test_nonpositive_denominator_keeps_absolute_change():
    for previous in ("0", "-5"):
        item = sections.daily_change([input_value(previous=previous, latest="2")])["items"][0]
        assert item["change_pct"] is None and Decimal(item["change"]) == 2 - Decimal(previous)
        assert item["status"] == "source_error"


def test_composite_real_source_calendar_and_sparse_confirmed_days(database, monkeypatch):
    import hashlib

    from alerts import briefing_inputs, series_access
    from alerts.storage import Instrument, MarketDataset, RealtimeMapping
    from test_live_session import generator

    scope = "sha256:" + hashlib.sha256(b"briefing-fixture").hexdigest()
    profile = generator()(
        scope,
        datetime.fromisoformat("2026-11-14T00:00:00+00:00"),
        datetime.fromisoformat("2026-11-20T00:00:00+00:00"),
        ["EUR_USD"],
    )["EUR_USD"]
    identity = {
        "source": "oanda",
        "channel": "v20",
        "environment": "practice",
        "account_scope": scope,
        "provider_symbol": "EUR_USD",
    }
    with database.begin() as db:
        inst = db.get(Instrument, "EURUSD")
        inst.calendar_profile = profile
        db.add(
            MarketDataset(
                id="b" * 64,
                instrument_id=inst.id,
                logical_symbol="EURUSD",
                identity=identity,
                asset_class="forex",
                volume_kind="unavailable",
            )
        )
        db.flush()
        db.add(
            RealtimeMapping(
                id="m" * 64,
                dataset_id="b" * 64,
                target_dataset_id="b" * 64,
                permission_scope="workspace:default",
                match={},
            )
        )
    end = at("2026-11-16T22:00:00+00:00")
    rows = input_value()["rows"]
    for i, row in enumerate(rows):
        row.update(
            start=end - (2 - i) * 86400000,
            end=end - (1 - i) * 86400000,
            complete=False,
            time_closed=True,
            source_confirmed=True,
            coverage_complete=False,
            observed_minutes=1435,
        )
    monkeypatch.setattr(
        series_access,
        "metadata",
        lambda *args: {
            "source": "composite",
            "symbol": "EURUSD",
            "calendar": "ny17",
            "calendar_profile": profile,
            "mapping_id": "m" * 64,
            "frames": ["D1"],
            "mobile_identity": {"category": "外汇", "provider": "OANDA"},
        },
    )
    monkeypatch.setattr(
        series_access, "chart_data", lambda *args: {"bars": rows, "input_revision": 5}
    )
    result = briefing_inputs.read("MWC:" + "a" * 64, NOW, deadline=1e12)
    assert result["status"] == "ok" and len(result["rows"]) == 2
    assert result["rows"][-1]["coverage_complete"] is False
    assert result["category"] == "外汇"
    item = sections.daily_change([result])["items"][0]
    assert item["change_pct"] is not None and item["bars"][-1]["observed_minutes"] == 1435
    rows[-1]["source_confirmed"] = False
    assert len(briefing_inputs.read("MWC:" + "a" * 64, NOW, deadline=1e12)["rows"]) == 1


def test_display_percent_normalizes_negative_zero():
    assert worker.display_percent("-0.000001") == "0.00%"
    assert worker.display_percent("1.235") == "+1.24%"
