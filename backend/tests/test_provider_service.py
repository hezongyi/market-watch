import pytest
from alerts import provider_cache as cache
from alerts import provider_chart as upstream
from alerts import provider_service as service
from alerts.storage import ProviderBar, ProviderDataset, ProviderInterest
from sqlalchemy import func, select
from test_provider_cache import META, page, seed

START_PROVIDER = service.start


def test_subscription_updates_use_reserved_realtime_lane(database, monkeypatch):
    from alerts.market_resources import LANE
    lanes = []
    def fetch(meta, frame, before, count, **kwargs):
        lanes.append(LANE.get())
        return page(before - count * 1000, before)
    monkeypatch.setattr(upstream, "native_page", fetch)
    subscribed(monkeypatch, "lane-test", "listener", 0)
    service.realtime_step()
    assert lanes == ["realtime"], "subscription updates cannot consume foreground chart reservations"


def subscribed(monkeypatch, client, listener, cursor, revision=0, observed=0, indicators=None):
    monkeypatch.setattr(upstream, "metadata", lambda instrument: META)
    return service.subscribe(
        client, listener, META["id"], "M5", cursor, revision, observed, indicators
    )


def test_registration_gap_and_python_indicator_use_cached_bars(database, monkeypatch):
    clock = [100000]
    monkeypatch.setattr(cache, "now_ms", lambda: clock[0])
    key = seed(META, "M5", 10000, page(1000, 10000))
    state = cache.snapshot(key, 10000, 3)
    clock[0] += 1000
    seed(META, "M5", 12000, page(9000, 12000, close="4"))
    subscribed(monkeypatch, "one", "native", 9000, state["cache_revision"], state["as_of"])
    subscribed(
        monkeypatch,
        "one",
        "sma",
        9000,
        state["cache_revision"],
        state["as_of"],
        [{"name": "SMA", "params": {"period": 3}}],
    )
    cursors = {}
    events = service.events("one", cursors)
    assert len(events) == 2 and all(e["type"] == "bars" for e in events)
    native = next(e for e in events if e["listener"] == "native")
    assert [b["start"] for b in native["bars"]] == [9000, 10000, 11000]
    indicator = next(e for e in events if e["listener"] == "sma")
    assert indicator["indicators"][0]["series"][0]["values"][-1]["value"] == 4
    assert service.events("one", cursors) == []
    assert service.events("other", {}) == []


def test_new_history_does_not_reset_but_old_revision_does(database, monkeypatch):
    clock = [100000]
    monkeypatch.setattr(cache, "now_ms", lambda: clock[0])
    key = seed(META, "M5", 10000, page(5000, 10000))
    state = cache.snapshot(key, 10000, 3)
    subscribed(monkeypatch, "c", "l", 9000, state["cache_revision"], state["as_of"])
    clock[0] += 1000
    seed(META, "M5", 5000, page(1000, 5000))
    cursors = {}
    assert service.events("c", cursors)[0]["type"] == "bars"
    clock[0] += 1000
    seed(META, "M5", 5000, page(4000, 5000, close="5"))
    assert service.events("c", cursors)[0]["type"] == "reset"


def test_four_swing_listeners_share_calculation_and_revision(database, monkeypatch):
    key = seed(META, "M5", 10000, page(1000, 10000))
    state = cache.snapshot(key, 10000, 3)
    spec = {"name": "SWING_SR_V1", "params": {"high_strength": 1, "low_strength": 1}}
    for listener in ("high", "high_left", "low", "low_left"):
        subscribed(monkeypatch, "swing", listener, 9000, state["cache_revision"],
                   state["as_of"], [spec | {"id": listener}])
    seed(META, "M5", 12000, page(9000, 12000, close="4"))
    calls = []
    from alerts import provider_indicator_inputs as inputs
    calculate = inputs.calculate

    def counted(rows, spec, **kwargs):
        calls.append(spec)
        return calculate(rows, spec, **kwargs)

    monkeypatch.setattr(inputs, "calculate", counted)
    cursors = {}
    events = service.events("swing", cursors)
    assert len(events) == 4
    assert len(calls) == 1, "four plots must not repeat full-history Swing calculation"
    presentations = [event["indicators"][0]["presentation"] for event in events]
    assert all(p == presentations[0] for p in presentations)
    assert presentations[0]["history_revision"] == str(events[0]["revision"])
    assert presentations[0]["history_complete"] is True
    assert presentations[0]["as_of_bar_time"] == 11000
    assert presentations[0]["statistics_origin"] == 1000
    assert service.events("swing", cursors) == []
    # Independent strengths and fixed origins remain independent calculations.
    subscribed(monkeypatch, "swing", "different-strength", 9000, indicators=[
        {"name": "SWING_SR_V1", "params": {"high_strength": 2, "low_strength": 1}}])
    subscribed(monkeypatch, "swing", "different-origin", 9000, indicators=[
        spec | {"calculation_origin": 2000}])
    changed = service.events("swing", cursors)
    assert len(changed) == 2 and len(calls) == 3
    origin = next(e for e in changed if e["listener"] == "different-origin")
    assert origin["indicators"][0]["presentation"]["statistics_origin"] == 2000


def test_uncovered_disconnect_gap_requires_reset(database, monkeypatch):
    seed(META, "M5", 10000, page(5000, 10000))
    subscribed(monkeypatch, "c", "l", 9000)
    seed(META, "M5", 20000, page(18000, 20000))
    event = service.events("c", {})[0]
    assert event["type"] == "reset" and event["bars"] == []


def test_python_subscription_cannot_calculate_across_disconnected_prefix(database, monkeypatch):
    seed(META, "M5", 10000, page(1000, 10000))
    key = seed(META, "M5", 20000, page(18000, 20000))
    state = cache.snapshot(key, 20000, 1)
    subscribed(monkeypatch, "c", "sma", 19000, state["cache_revision"], state["as_of"],
        [{"name": "SMA", "params": {"period": 3}}])
    seed(META, "M5", 20000, page(19000, 20000, close="4"))
    event = service.events("c", {})[0]
    assert event["type"] == "reset" and event["indicators"] == [], (
        "an indicator needs a proven continuous prefix before SSE can calculate it"
    )


def test_session_targets_finite_two_rounds_and_no_recursive_activation(database, monkeypatch):
    key = seed(META, "M5", 100000, page(90000, 100000))
    service.activate("a", key, 100000, 10, latest=True)
    service.activate("b", key, 50000, 10, latest=False)
    with database.begin() as db:
        a = db.get(ProviderInterest, service.interest_id("a", "read:" + key + ":latest"))
        b = db.get(ProviderInterest, service.interest_id("b", "read:" + key + ":history"))
        assert len(a.targets) == 18 and len(b.targets) == 20
        assert [t["frame"] for t in a.targets[:9]] == [
            "M5",
            "D1",
            "W1",
            "H4",
            "M1",
            "MN",
            "H1",
            "M30",
            "M15",
        ]
        assert [t["count"] for t in a.targets[:9]] == [1000] * 9
        assert [t["count"] for t in a.targets[9:]] == [4000] * 9
        assert a.cursor == 100000 and b.cursor == 50000
    calls = []

    def fetch(meta, frame, before, count, **kwargs):
        calls.append((frame, before, count))
        return page(before - count * 1000, before)

    monkeypatch.setattr(upstream, "native_page", fetch)
    service.warm_step("oanda")
    assert len(calls) == 1, "one background iteration fetches at most one adapter page"
    with database.begin() as db:
        assert db.scalar(select(func.count()).select_from(ProviderInterest)) == 2
    service.activate("a", key, 100100, 10, latest=True)
    with database.begin() as db:
        assert (
            db.get(ProviderInterest, service.interest_id("a", "read:" + key + ":latest")).cursor
            == 100000
        )
        assert (
            db.get(ProviderInterest, service.interest_id("b", "read:" + key + ":history")).cursor
            == 50000
        )


def test_configured_interest_limit_evicts_only_older_reads_of_the_same_session(database, monkeypatch):
    monkeypatch.setattr(service.settings, "provider_interest_limit", 2)
    clock = [100000]
    monkeypatch.setattr(service, "now_ms", lambda: clock[0])
    keys = [seed({**META, "symbol": f"LIMIT_{n}"}, "M5", 10000, page(1000, 10000))
            for n in range(3)]
    service.activate("peer", keys[0], 10000, 3, latest=True)
    with database.begin() as db:
        db.add(ProviderInterest(
            id=service.interest_id("owner", "visible"), client="owner", listener="visible",
            dataset_id=keys[0], subscribed=True, expires=200000, accessed_at=1,
            cursor=0, revision=0, next_poll=0, targets=[],
        ))
    for key in keys:
        clock[0] += 1000
        service.activate("owner", key, 10000, 3, latest=True)
    with database.begin() as db:
        reads = list(db.scalars(select(ProviderInterest).where(
            ProviderInterest.client == "owner", ProviderInterest.subscribed.is_(False))))
        assert {row.dataset_id for row in reads} == set(keys[1:])
        assert db.get(ProviderInterest, service.interest_id("owner", "visible"))
        assert db.get(ProviderInterest, service.interest_id("peer", "read:" + keys[0] + ":latest"))


def test_background_yields_to_foreground_and_continues_after_failed_period(database, monkeypatch):
    key = seed(META, "M5", 10000000, page(9990000, 10000000))
    service.activate("a", key, 10000000, 10, latest=True)
    monkeypatch.setattr(cache, "interactive_busy", lambda source: True)
    monkeypatch.setattr(
        upstream,
        "native_page",
        lambda *a, **k: pytest.fail("foreground must preempt queued warming"),
    )
    service.warm_step("oanda")
    monkeypatch.setattr(cache, "interactive_busy", lambda source: False)
    calls = []

    def fetch(meta, frame, before, count, **kwargs):
        calls.append(frame)
        if frame == "M5":
            raise TimeoutError("fixture")
        return page(before - count * 1000, before)

    monkeypatch.setattr(upstream, "native_page", fetch)
    service.warm_step("oanda")
    service.warm_step("oanda")
    assert calls == ["M5", "D1"], "a backed-off frame does not block other basic targets"


def test_shared_cached_goals_do_not_delay_other_sessions_by_seconds(database, monkeypatch):
    key = seed(META, "M5", 100000, page(90000, 100000))
    for index in range(9):
        client = "cached-" + str(index)
        service.activate(client, key, 100000, 3, latest=True)
        with database.begin() as db:
            db.get(ProviderInterest, service.interest_id(client, "read:" + key + ":latest")).targets = [{
                "frame": "M5", "before": 100000, "count": 3, "done": False,
                "next_at": 0, "attempts": 0,
            }]
    monkeypatch.setattr(upstream, "native_page", lambda *a, **k: pytest.fail("shared cache cannot be fetched again"))
    waits, submitted = [], []
    class Stop:
        def clear(self): pass
        def is_set(self): return len(waits) >= 9
        def wait(self, seconds): waits.append(seconds)
    class Executor:
        def __init__(self, **kwargs): pass
        def submit(self, fn, *args): submitted.append((fn,args))
    monkeypatch.setattr(service, "_STOP", Stop())
    monkeypatch.setattr(service, "_EXECUTOR", None)
    monkeypatch.setattr(service, "_FUTURES", [])
    monkeypatch.setattr(service, "ThreadPoolExecutor", Executor)
    START_PROVIDER()
    worker,args = submitted[0]
    worker(*args)
    with database.begin() as db:
        assert all(row.targets[0]["done"] for row in db.scalars(select(ProviderInterest)))
    assert sum(waits) < 1, "shared cached completions cannot add one second per session before useful background work"


def test_unsubscribe_and_interest_renewal_are_scoped(database, monkeypatch):
    key = seed(META, "M5", 10000, page(1000, 10000))
    service.activate("a", key, 10000, 3, latest=True)
    service.activate("b", key, 10000, 3, latest=True)
    subscribed(monkeypatch, "a", "same", 9000)
    subscribed(monkeypatch, "b", "same", 9000)
    service.unsubscribe("a", "same")
    with database.begin() as db:
        assert db.get(ProviderInterest, service.interest_id("a", "same")) is None
        assert db.get(ProviderInterest, service.interest_id("b", "same")) is not None
        old = db.get(ProviderInterest, service.interest_id("b", "read:" + key + ":latest")).expires
    monkeypatch.setattr(service, "now_ms", lambda: old - 5000)
    service.renew("b")
    with database.begin() as db:
        assert (
            db.get(ProviderInterest, service.interest_id("b", "read:" + key + ":latest")).expires
            > old
        )
        assert (
            db.get(ProviderInterest, service.interest_id("a", "read:" + key + ":latest")).expires
            <= old
        )


def test_error_events_are_observable_and_recovery_resumes(database, monkeypatch):
    seed(META, "M5", 10000, page(1000, 10000))
    subscribed(monkeypatch, "a", "one", 9000)
    with database.begin() as db:
        db.get(ProviderInterest, service.interest_id("a", "one")).error = "TimeoutError"
    cursor = {}
    assert service.events("a", cursor)[0]["type"] == "error"
    assert service.events("a", cursor) == []
    monkeypatch.setattr(cache, "read", lambda *a, **k: {})
    service.realtime_step("oanda")
    with database.begin() as db:
        assert db.get(ProviderInterest, service.interest_id("a", "one")).error is None


def test_cleanup_removes_expired_coverage_with_data_not_active_interest(database, monkeypatch):
    old = seed({**META, "symbol": "UNUSED"}, "M5", 10000, page(1000, 10000))
    sibling = seed(META, "M5", 10000, page(1000, 10000))
    active = seed(META, "H4", 10000, page(1000, 10000))
    service.activate("a", active, 10000, 3, latest=True)
    with database.begin() as db:
        db.get(ProviderDataset, old).accessed_at = 0
        db.get(ProviderDataset, active).accessed_at = 0
        db.get(ProviderDataset, sibling).accessed_at = 0
    service.cleanup()
    with database.begin() as db:
        assert db.get(ProviderDataset, old) is None
        assert (
            db.scalar(
                select(func.count()).select_from(ProviderBar).where(ProviderBar.dataset_id == old)
            )
            == 0
        )
        assert db.get(ProviderDataset, active).coverage
        assert db.get(ProviderDataset, sibling).coverage, (
            "active cross-period targets protect their cached data"
        )


def test_cleanup_protects_active_history_consumer_until_expiry(database, monkeypatch):
    from alerts.storage import NativeHistoryLoad
    monkeypatch.setattr(upstream, 'metadata', lambda *a, **k: META)
    key = seed(META, 'M5', 10000, page(1000, 10000))
    now = cache.now_ms()
    with database.begin() as db:
        db.get(ProviderDataset, key).accessed_at = 0
        db.add(NativeHistoryLoad(id='protected', owner='owner', request_id='request',
            query_json={'instrument': META['id'], 'timeframe': 'M5'}, state='waiting',
            consumer_until=now + 45000, deadline=now + 60000))
    service.cleanup()
    with database.begin() as db:
        assert db.get(ProviderDataset, key).coverage
        db.get(NativeHistoryLoad, 'protected').consumer_until = 0
    service.cleanup()
    with database.begin() as db:
        assert db.get(ProviderDataset, key) is None


def test_unchanged_reobservation_does_not_invalidate_already_loaded_revision(database, monkeypatch):
    clock = [100000]
    monkeypatch.setattr(cache, "now_ms", lambda: clock[0])
    seed(META, "M5", 10000, page(1000, 10000))
    clock[0] += 1000
    key = seed(META, "M5", 5000, page(4000, 5000, close="5"))
    state = cache.snapshot(key, 10000, 5)
    subscribed(monkeypatch, "c", "l", 9000, state["cache_revision"], state["as_of"])
    clock[0] += 1000
    seed(META, "M5", 5000, page(4000, 5000, close="5"))
    event = service.events("c", {})[0]
    assert event["type"] == "bars", (
        "observing an unchanged historical revision again must not reset"
    )


def test_historical_right_buffer_counts_real_bars_across_market_closure(database, monkeypatch):
    clock = [20000]
    monkeypatch.setattr(service, "now_ms", lambda: clock[0])
    monkeypatch.setitem(upstream.FRAME_MS, "M5", 1000)
    monkeypatch.setattr(service.settings, "provider_basic_bars", 3)
    key = seed(META, "M5", 10000, page(5000, 10000))
    service.activate("a", key, 10000, 3, latest=False)
    ident = service.interest_id("a", "read:" + key + ":history")
    with database.begin() as db:
        interest = db.get(ProviderInterest, ident)
        interest.targets = [next(t for t in interest.targets if t.get("after") == 10000)]
    calls = []
    def fetch(meta, frame, before, count, **kwargs):
        calls.append((before, count))
        # The source is closed from 10000 through 14000. A count/to query
        # still returns older bars, which cannot satisfy a right-hand buffer.
        times = [at for at in range(1000, before, 1000) if not 10000 <= at < 14000][-count:]
        return {"bars": [page(at, at + 1000)["bars"][0] for at in times], "history_boundary": False}
    monkeypatch.setattr(upstream, "native_page", fetch)
    service.warm_step("oanda")
    with database.begin() as db:
        assert not db.get(ProviderInterest, ident).targets[0]["done"], "older bars cannot count as right-hand warming"
    for _ in range(10):
        clock[0] += 1001
        service.warm_step("oanda")
    with database.begin() as db:
        target = db.get(ProviderInterest, ident).targets[0]
        assert target["done"]
        assert db.scalar(select(func.count()).select_from(ProviderBar).where(
            ProviderBar.dataset_id == key, ProviderBar.chart_time >= 10000,
            ProviderBar.chart_time < target["before"],
        )) == 3
        assert target["before"] <= target["until"] == 20001
    assert len(calls) == 3, "finite completed buffers do not fetch again or recursively extend"


def test_same_anchor_historical_demand_growth_only_expands_focus_left_targets(database, monkeypatch):
    monkeypatch.setattr(service.settings, 'provider_basic_bars', 3)
    monkeypatch.setattr(service.settings, 'provider_depth_bars', 8)
    key = seed(META, 'M5', 100000, page(90000, 100000))
    service.activate('grow', key, 100000, 2, latest=False)
    ident = service.interest_id('grow', 'read:' + key + ':history')
    with database.begin() as db:
        row = db.get(ProviderInterest, ident)
        originals = [dict(t) for t in row.targets]
        row.targets = [{**t, 'done': True} for t in row.targets]
    service.activate('grow', key, 100000, 10, latest=False)
    with database.begin() as db:
        targets = db.get(ProviderInterest, ident).targets
        assert len(targets) == 20
        for original, target in zip(originals, targets):
            if target['frame'] == 'M5' and 'after' not in target:
                assert target['count'] == target['goal'] + 10
                assert target['generation'] == 1
                assert not target['done']
            else:
                assert target['count'] == original['count'] and target['done']
                assert target['generation'] == 0
            assert target['task_id'] == original['task_id']
