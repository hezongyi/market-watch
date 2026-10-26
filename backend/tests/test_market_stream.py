"""Exercise shared publication, cancellation fencing and bounded recovery."""

import pytest
from alerts import market_stream as stream
from alerts.storage import (
    LoginSession,
    MarketStreamClient,
    MarketStreamResult,
    MarketStreamSubscription,
    MarketStreamTask,
)
from sqlalchemy import event, func, select


def session(database, key="session"):
    with database.begin() as db:
        db.add(LoginSession(token_hash=key, csrf="csrf", expires=stream.now_ms() + 1000000))
    return key


def register(owner, client="page", listener="chart", generation=1, state=None):
    return stream.register(owner, client, listener, generation,
                           {"kind": "bars", "dataset": "independent"},
                           {"instrument": "EURUSD", "timeframe": "M1"}, state or {})


def test_external_indicator_prefix_is_consumer_state_not_shared_calculation(database):
    from types import SimpleNamespace

    from alerts.chart_query import DataQuery
    from alerts.market_stream_api import Subscription
    from alerts.storage import ProviderBar, ProviderDataset

    query = DataQuery(instrument="OANDA:TEST", series_kind="provider", timeframe="M1")
    body = Subscription(client="page", listener="chart", generation=1, kind="bars", query=query,
                        dependency_origin=10 * 60000)
    assert body.query.indicators == [], "dependency evidence must not start a second Python calculator"
    with database.begin() as db:
        db.add(ProviderDataset(id="dependency-test", source="oanda", symbol="TEST", timeframe="M1",
            metadata_json={}, coverage=[], revision=2, updated_at=2000))
        db.flush()
        db.add(ProviderBar(dataset_id="dependency-test", start=20 * 60000, chart_time=20 * 60000,
            complete=True, payload={}, observed_at=2000, changed_at=2000, revision=2))
        db.flush()
        task = SimpleNamespace(query=query.model_dump(), identity={"dataset_id": "dependency-test"})
        state = dict(history_accepted=True, historical=True, loaded_before=25 * 60000,
                     loaded_after=24 * 60000, observed_at=1000, cursor=25 * 60000)
        payload = {"type": "bars", "bars": [{"start": 30 * 60000, "chart_time": 30 * 60000}]}
        plain = SimpleNamespace(listener="plain", generation=1, state=state)
        external = SimpleNamespace(listener="external", generation=1,
            state={**state, "dependency_origin": body.dependency_origin})
        assert stream.delivery(db, task, plain, payload, {})["type"] == "status"
        cursors = {}
        event = stream.delivery(db, task, external, payload, cursors)
        assert event["type"] == "status" and event["indicator_correction"]
        assert not stream.delivery(db, task, external, payload, cursors).get("indicator_correction"), "same evidence must not repeatedly withdraw results"


def test_published_external_prefix_uses_accepted_snapshot_and_preserves_tail(database):
    from types import SimpleNamespace

    from alerts.chart_query import DataQuery
    from alerts.managed_dataset import published_history_check
    from alerts.storage import ChartPublication, ChartPublishedBar, Instrument
    query = DataQuery(instrument="BTCUSDT", series_kind="managed", timeframe="M1", published=True)
    with database.begin() as db:
        publication = ChartPublication(instrument_id="BTCUSDT", timeframe="M1", start=60000,
            end=360000, complete_count=5, initialized=True, revision=1)
        db.add(publication)
        for start in (60000, 120000, 180000, 240000, 300000):
            db.add(ChartPublishedBar(instrument_id="BTCUSDT", timeframe="M1", start=start,
                end=start+60000, complete=True, payload={}, revision=1))
        db.flush()
        tail = {"start": 300000}
        credential = published_history_check(db, db.get(Instrument, "BTCUSDT"), publication, [tail],
            query.model_copy(update={"track_history": True, "revision_before": 240000}))
        state = dict(history_accepted=True, historical=False, loaded_before=300000,
            loaded_after=240000, dependency_origin=60000, dependency_before=240000,
            dependency_revision=credential["revision"], cursor=300000)
        task = SimpleNamespace(query=query.model_dump(), identity={})
        sub = SimpleNamespace(listener="external", generation=1, state=state)
        cursors = {}
        payload = {"type": "bars", "bars": [tail]}
        assert not stream.delivery(db, task, sub, payload, cursors).get("indicator_correction")
        db.get(ChartPublishedBar, ("BTCUSDT", "M1", 120000)).revision += 1
        db.flush()
        corrected = stream.delivery(db, task, sub, payload, cursors)
        assert corrected["type"] == "bars" and corrected["bars"] == [tail]
        assert corrected["indicator_correction"]
        assert corrected["dependency_revision"] != state["dependency_revision"]
        assert not stream.delivery(db, task, sub, payload, cursors).get("indicator_correction")
        # Staging changes and normal tail appends cannot alter published prefix proof.
        db.add(ChartPublishedBar(instrument_id="BTCUSDT", timeframe="M1", start=360000,
            end=420000, complete=True, payload={}, revision=1))
        db.flush()
        assert not stream.delivery(db, task, sub, {"type": "bars", "bars": [{"start": 360000}]}, cursors).get("indicator_correction")


def test_multiple_pages_share_one_calculation_and_session_scopes_listeners(database):
    owner = session(database)
    other = session(database, "other")
    a = register(owner)
    b = register(owner, "second")
    c = register(other)
    assert a["task_id"] == b["task_id"] == c["task_id"]
    with database.begin() as db:
        assert db.scalar(select(func.count()).select_from(MarketStreamTask)) == 1
        assert db.scalar(select(func.count()).select_from(MarketStreamSubscription)) == 3
    ownership = stream.claim()
    assert stream.claim() is None
    stream.commit(ownership, {"type": "bars", "bars": [{"start": 60000, "close": "1.1"}]})
    assert len(stream.events(owner, "page", {})) == 1
    assert len(stream.events(other, "page", {})) == 1


def test_idle_lease_and_delivery_do_not_read_retained_history_snapshot(database):
    owner = session(database)
    register(owner)
    stream.commit(stream.claim(), {"type":"bars", "bars":[
        {"start":index * 60000,"close":"1.1"} for index in range(2000)]}, delay_ms=0)
    cursor = {}
    assert stream.events(owner, "page", cursor)
    statements = []
    engine = database.kw["bind"]

    def observe(conn, db_cursor, statement, parameters, context, executemany):
        if statement.lstrip().upper().startswith("SELECT"):
            statements.append(statement)

    event.listen(engine, "before_cursor_execute", observe)
    try:
        for _ in range(3):
            stream.renew(owner, "page")
            work = stream.claim()
            assert work
            stream.commit(work, None, delay_ms=0)
            assert stream.events(owner, "page", cursor) == []
    finally:
        event.remove(engine, "before_cursor_execute", observe)
    assert not any("market_stream_tasks.payload" in statement for statement in statements), (
        "Idle delivery/lease checks must not transfer the full 2000-bar snapshot")


def test_composite_history_snapshot_budget_allows_windowed_native_delivery(database):
    owner = session(database)
    tail = 2000 * 60000
    register(owner,state={"cursor":tail,"history_accepted":True})
    payload = {"type":"bars","bars":[{"start":index * 60000,"close":"1.1",
        "segments":[{"evidence":"x" * 1100}]} for index in range(1,2001)]}
    stream.commit(stream.claim(),payload)
    rows = stream.events(owner,"page",{})
    assert len(rows) == 1 and rows[0]["type"] == "bars"
    assert len(rows[0]["bars"]) == 1 and rows[0]["bars"][0]["start"] == tail


def test_recursive_study_feeds_deliver_only_values_for_accepted_tail_bars(database):
    owner = session(database)
    count, span, date_offset = 4500, 86400000, 10800000
    tail = count * span
    # Native Supertrend subscribes to five plots of the same six-output study.
    # Daily chart dates differ from the input start keys used by indicator values.
    for index in range(5):
        register(owner, listener=f"plot{index}", state={
            "cursor": tail + date_offset, "history_accepted": True})
    register(owner, client="earlier", state={
        "cursor": tail - span + date_offset, "history_accepted": True})
    keys = ("up", "down", "buy_price", "sell_price", "fill_reference", "direction")
    values = [{"time": index * span, "value": 1.1234567890123456}
              for index in range(1, count + 1)]
    payload = {"type": "bars", "bars": [{
        "start": index * span, "chart_time": index * span + date_offset, "close": "1.1"}
        for index in range(count - 1999, count + 1)],
        "indicators": [{"name": "SUPERTREND_PINE_V1", "series": [
            {"key": key, "values": values if key != "buy_price" else [
                {**value, "value": None} for value in values]} for key in keys]}]}
    stream.commit(stream.claim(), payload)
    rows = stream.events(owner, "page", {})
    assert len(rows) == 5
    assert all(row["type"] == "bars" for row in rows), "Full-prefix values cause delivery_budget reloads"
    for row in rows:
        assert len(row["bars"]) == 1 and row["bars"][0]["start"] == tail
        assert all(len(series["values"]) == 1 and series["values"][0]["time"] == tail
                   for series in row["indicators"][0]["series"])
        assert row["indicators"][0]["series"][2]["values"][0]["value"] is None
    earlier = stream.events(owner, "earlier", {})[0]
    assert [value["time"] for value in earlier["indicators"][0]["series"][0]["values"]] == [
        tail - span, tail]
    # Consumer filtering must not destroy the retained calculation snapshot.
    with database.begin() as db:
        retained = db.scalar(select(MarketStreamTask)).payload
        assert len(retained["indicators"][0]["series"][0]["values"]) == count


def test_old_cancel_duplicate_register_and_late_register_do_not_remove_new_generation(database):
    owner = session(database)
    register(owner, generation=2)
    stream.cancel(owner, "page", "chart", 1)
    assert register(owner, generation=2)["generation"] == 2
    assert register(owner, generation=1)["stale"]
    stream.cancel(owner, "page", "chart", 2)
    assert register(owner, generation=2)["stale"]
    with database.begin() as db:
        assert not db.scalar(select(MarketStreamSubscription)).active


def test_expired_owner_cannot_publish_after_successor(database):
    owner = session(database)
    info = register(owner)
    old = stream.claim()
    with database.begin() as db:
        db.get(MarketStreamTask, info["task_id"]).lease_until = 0
    successor = stream.claim()
    assert successor["token"] != old["token"]
    with pytest.raises(TimeoutError):
        stream.commit(old, {"type": "bars"})
    stream.commit(successor, {"type": "status", "status": "ready"})


def test_result_sequence_rejects_stale_same_bar_and_recovers_or_resets(database):
    owner = session(database)
    register(owner)
    for i in range(stream.RESULT_LIMIT + 2):
        work = stream.claim()
        stream.commit(work, {"type": "bars", "bars": [{"start": 60000, "close": str(i)}]}, delay_ms=0)
    cursor = {}
    rows = stream.events(owner, "page", cursor)
    assert rows[0]["type"] == "reset" and rows[0]["reason"] == "recovery_budget"
    assert stream.events(owner, "page", cursor) == []
    work = stream.claim()
    stream.commit(work, {"type": "bars", "bars": [{"start": 60000, "close": "latest"}]}, delay_ms=0)
    rows = stream.events(owner, "page", cursor)
    assert len(rows) == 1 and rows[0]["sequence"] == stream.RESULT_LIMIT + 3


def test_slow_consumer_does_not_block_fast_delivery_and_replay_is_bounded(database):
    owner = session(database)
    register(owner, "fast")
    register(owner, "slow")
    fast, slow = {}, {}
    for index in range(stream.RESULT_LIMIT + 5):
        stream.commit(stream.claim(), {"type":"bars", "bars":[
            {"start":(offset+1) * 60000,"close":"1.1"} for offset in range(index+1)]}, delay_ms=0)
        rows = stream.events(owner, "fast", fast)
        assert len(rows) == 1 and rows[0]["type"] == "bars"
        assert rows[0]["bars"][-1]["start"] == (index+1) * 60000
    with database.begin() as db:
        assert db.scalar(select(func.count()).select_from(MarketStreamResult)) == stream.RESULT_LIMIT
    rows = stream.events(owner, "slow", slow)
    assert len(rows) == 1 and rows[0]["type"] == "reset"
    assert rows[0]["reason"] == "recovery_budget"
    stream.commit(stream.claim(), {"type":"bars", "bars":[
        {"start":(offset+1) * 60000,"close":"1.1"}
        for offset in range(stream.RESULT_LIMIT+6)]}, delay_ms=0)
    assert stream.events(owner, "fast", fast)[0]["type"] == "bars"


def test_repeated_binding_retirement_cleans_only_expired_task_resources(database,monkeypatch):
    stamp = [stream.now_ms()]
    monkeypatch.setattr(stream,"now_ms",lambda:stamp[0])
    owner = session(database)
    live = register(owner,client="retained")
    for index in range(20):
        generation = index+1
        stream.register(owner,"switching","chart",generation,
            {"kind":"bars","dataset":str(index)},
            {"instrument":"EURUSD","timeframe":"M1"},{})
        work = stream.claim()
        assert work
        stream.commit(work,{"type":"status","status":str(index)},delay_ms=1000000)
    stream.cancel(owner,"switching","chart",20)
    stamp[0] += stream.LEASE_MS-1000
    stream.renew(owner,"retained")
    stamp[0] += 2000
    stream.cleanup()
    with database.begin() as db:
        assert list(db.scalars(select(MarketStreamTask.id))) == [live["task_id"]]
        assert db.scalar(select(func.count()).select_from(MarketStreamSubscription)) == 1
        assert db.scalar(select(func.count()).select_from(MarketStreamClient)) == 1
        assert not db.scalar(select(MarketStreamResult.task_id).where(MarketStreamResult.task_id!=live["task_id"]))


def test_session_end_disables_work_and_output(database):
    owner = session(database)
    register(owner)
    with database.begin() as db:
        db.get(LoginSession, owner).expires = 0
    assert stream.claim() is None
    with pytest.raises(PermissionError):
        stream.events(owner, "page", {})


def test_unconfirmed_previous_minute_retraction_requires_history_restore(database):
    owner = session(database)
    register(owner)
    work = stream.claim()
    stream.commit(work, {"type": "bars", "bars": [{"start": 0}, {"start": 60000}]}, delay_ms=0)
    cursor = {}
    assert stream.events(owner, "page", cursor)[0]["type"] == "bars"
    work = stream.claim()
    stream.commit(work, {"type": "bars", "bars": [{"start": 0}, {"start": 120000}]}, delay_ms=0)
    event = stream.events(owner, "page", cursor)[0]
    assert event["type"] == "reset" and event["reason"] == "tail_retracted"


def test_new_generation_starts_at_latest_snapshot_and_same_generation_replays(database):
    owner = session(database)
    register(owner)
    for i in range(3):
        stream.commit(stream.claim(), {"type": "bars", "bars": [{"start": 60000, "close": str(i)}]}, delay_ms=0)
    register(owner, generation=2)
    cursor = {}
    rows = stream.events(owner, "page", cursor)
    assert len(rows) == 1 and rows[0]["sequence"] == 3 and rows[0]["bars"][0]["close"] == "2"
    register(owner, generation=2, state={"sequence": 2})
    assert stream.events(owner, "page", {})[0]["sequence"] == 3


def test_worker_affinity_keeps_current_bucket_owner_until_failure_takeover(database):
    owner = session(database)
    info = register(owner)
    work = stream.claim(owner="worker-one")
    stream.commit(work, {"type": "status", "status": "ready"}, delay_ms=0)
    assert stream.claim(owner="worker-two") is None
    work = stream.claim(owner="worker-one")
    stream.commit(work, None, delay_ms=0)
    with database.begin() as db:
        db.get(MarketStreamTask, info["task_id"]).owner_until = 0
    assert stream.claim(owner="worker-two") is not None


def test_empty_first_history_receives_status_then_recovery_before_native_bars(database):
    owner = session(database)
    register(owner, state={"history_accepted": False})
    cursor = {}
    stream.commit(stream.claim(), {"type": "bars", "bars": [], "pending": ["preparing"]}, delay_ms=0)
    first = stream.events(owner, "page", cursor)[0]
    assert first["type"] == "status" and first["status"] == "preparing"
    stream.commit(stream.claim(), {"type": "bars", "bars": [{"start": 60000}]}, delay_ms=0)
    ready = stream.events(owner, "page", cursor)[0]
    assert ready["type"] == "reset" and ready["reason"] == "initial_history_ready"
    assert "bars" not in ready


def test_replay_checks_each_committed_result_without_looking_ahead(database):
    owner = session(database)
    register(owner, state={"cursor": 60000})
    stream.commit(stream.claim(), {"type": "bars", "bars": [{"start": 60000}]}, delay_ms=0)
    cursor = {}
    stream.events(owner, "page", cursor)
    for at in (120000, 180000):
        stream.commit(stream.claim(), {"type": "bars", "bars": [{"start": 60000}, {"start": at}]}, delay_ms=0)
    rows = stream.events(owner, "page", cursor)
    assert [event["type"] for event in rows] == ["bars", "reset"]
    assert rows[0]["bars"][-1]["start"] == 120000


def test_disconnect_beyond_retained_bar_window_requires_reset(database):
    owner = session(database)
    register(owner, state={"cursor": 60000})
    stream.commit(stream.claim(), {"type": "bars", "bars": [{"start": 60000}]}, delay_ms=0)
    cursor = {}
    stream.events(owner, "page", cursor)
    stream.commit(stream.claim(), {"type": "bars", "bars": [{"start": 12000000}, {"start": 12060000}]}, delay_ms=0)
    event = stream.events(owner, "page", cursor)[0]
    assert event["type"] == "reset", "bounded tail cannot prove an arbitrarily long gap is complete"


def test_indicator_only_change_delivers_native_bar_at_its_own_time(database):
    import copy

    owner = session(database)
    register(owner)
    payload = {"type": "bars", "bars": [{"start": at, "close": "1.1"} for at in (60000, 120000)],
        "indicators": [{"id": "ema", "series": [{"key": "value", "values": [
            {"time": at, "value": 1.1} for at in (60000, 120000)]}]}]}
    stream.commit(stream.claim(), payload, delay_ms=0)
    cursors = {}
    stream.events(owner, "page", cursors)
    changed = copy.deepcopy(payload)
    changed["indicators"][0]["series"][0]["values"][-1]["value"] = 1.2
    stream.commit(stream.claim(), changed, delay_ms=0)
    event = stream.events(owner, "page", cursors)[0]
    assert [bar["start"] for bar in event["bars"]] == [120000], \
        "native indicator feed derives its callbacks from the accompanying bars"
    assert event["indicators"][0]["series"][0]["values"] == [{"time": 120000, "value": 1.2}]
