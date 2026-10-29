"""Regression scenarios found during PR115 review, shared with PostgreSQL."""
import test_composite_revisions as revisions
import test_retention_window as retention
from alerts import baseline_shadow, composite_alerts, composite_inputs, composite_preparation
from alerts import retention_window as window
from alerts.source_history_store import store_blob
from alerts.storage import (
    CompositePreparation,
    Notification,
    Outbox,
    SourceBlob,
    SourceFetch,
    SourceMinuteRevision,
    SourceSeries,
)
from sqlalchemy import event, func, select
from test_composite_chart import populated
from test_composite_definitions import publish
from test_switch_activation import late_batch

runtime = retention.runtime


def contract_unrelated_source(factory):
    retention.graph(factory)
    with factory.begin() as db:
        db.add(SourceSeries(id='other-source', identity={'source':'other', 'account_scope':'other'}))
    foreign = retention.bare(factory, retention.OLD-60000, source_id='other-source')
    retention.drill()
    report = window.execute(retention.run(factory), now=retention.NOW)
    with factory() as db:
        assert db.get(SourceMinuteRevision, foreign) is not None
    assert report['deleted']['market_source_minutes'] == 1


def contract_raw_page_cleanup(factory):
    retention.graph(factory)
    with factory.begin() as db:
        source_id = db.scalar(select(SourceSeries.id))
        blob, _ = store_blob(db, source_id, b'[{"timestamp":1,"close":"1.1"}]')
        db.add(SourceFetch(id='review-page',source_id=source_id,start=retention.OLD-60000,
            end=retention.OLD,content_id=blob,lease_until=0,fetched_at=1))
    retention.drill()
    window.execute(retention.run(factory),now=retention.NOW)
    with factory() as db:
        assert db.get(SourceFetch,'review-page') is None
        assert db.get(SourceBlob,blob) is None


def contract_page_boundary_and_orphans(factory):
    import json

    retention.graph(factory)
    with factory.begin() as db:
        source_id = db.scalar(select(SourceSeries.id))
        old, _ = store_blob(db, source_id, json.dumps([{"timestamp": retention.OLD-120000}]).encode())
        recent, _ = store_blob(db, source_id, json.dumps([{"timestamp": retention.LOWER}]).encode())
        db.add(SourceFetch(id="crossing-page", source_id=source_id, start=retention.OLD,
            end=retention.LOWER+60000, content_id=recent, lease_until=0, fetched_at=1))
    run_id = retention.run(factory)
    before = window.dry_run(run_id, now=retention.NOW)
    assert before["candidates"]["source_blobs"] == 1
    retention.drill()
    report = window.execute(run_id, now=retention.NOW)
    assert report["deleted"]["market_source_blobs"] == 1
    with factory() as db:
        assert db.get(SourceBlob, old) is None
        assert db.get(SourceBlob, recent) is not None
        assert db.get(SourceFetch, "crossing-page") is not None
    assert window.execute(run_id, now=retention.NOW)["idempotent"]


def test_page_boundary_and_orphans(runtime):
    contract_page_boundary_and_orphans(runtime)


def contract_blob_scan_resumes_past_retained_prefix(factory):
    import gzip
    import hashlib
    import json

    retention.graph(factory, starts=())
    with factory.begin() as db:
        for ident, start in (("0-recent", retention.LOWER), ("z-old", retention.OLD-120000)):
            raw = json.dumps([{"timestamp": start}]).encode()
            db.add(SourceBlob(id=ident, source_id=retention.SOURCE.key,
                checksum=hashlib.sha256(raw).hexdigest(), content=gzip.compress(raw)))
    retention.drill()
    run_id = retention.run(factory)
    first = window.execute(run_id, now=retention.NOW, limit=1, chunk=1)
    assert first["batch"]["state"] == "interrupted"
    assert first["batch"]["stats"]["blob_scan"]["cursor"] == "0-recent"
    second = window.execute(run_id, now=retention.NOW, limit=1, chunk=1)
    assert second["deleted"]["market_source_blobs"] == 1
    third = window.execute(run_id, now=retention.NOW, limit=1, chunk=1)
    assert third["batch"]["state"] == "completed"
    assert window.execute(run_id, now=retention.NOW)["idempotent"]
    with factory() as db:
        assert db.get(SourceBlob, "0-recent") is not None
        assert db.get(SourceBlob, "z-old") is None


def test_blob_scan_resumes_past_retained_prefix(runtime):
    contract_blob_scan_resumes_past_retained_prefix(runtime)


def test_unrelated_source(runtime):
    contract_unrelated_source(runtime)


def test_raw_page_cleanup(runtime):
    contract_raw_page_cleanup(runtime)


def contract_old_products_preserve_history_and_active_refs(factory):
    import json

    from alerts.storage import CompositeAggregateBar, HistoryChunk

    retention.graph(factory)
    with factory.begin() as db:
        blob, checksum = store_blob(db, retention.SOURCE.key,
            json.dumps([{"timestamp": retention.OLD-120000}]).encode())
        db.add(HistoryChunk(id="kept-history", version_id="hist", start=0, end=60000,
            observed_at=1, count=1, checksum=checksum, content=b"", content_id=blob,
            result="data"))
        db.add(SourceFetch(id="expired-shared-page", source_id=retention.SOURCE.key,
            start=retention.OLD-120000, end=retention.OLD, content_id=blob, lease_until=0))
        for revision, start, end in (("rev-old", retention.OLD-120000, retention.OLD),
                                     ("rev-old", retention.OLD, retention.LOWER+60000),
                                     ("rev-active", retention.OLD-120000, retention.OLD)):
            db.add(CompositeAggregateBar(revision_id=revision, timeframe="M1", start=start,
                input_revision=0, data={"end": end}))
    retention.drill()
    report = window.execute(retention.run(factory), now=retention.NOW)
    assert report["deleted"]["market_composite_aggregate_bars"] == 1
    assert report["deleted"]["market_source_fetches"] == 1
    with factory() as db:
        assert db.get(SourceBlob, blob) is not None
        assert db.get(HistoryChunk, "kept-history") is not None
        assert db.scalar(select(func.count()).select_from(CompositeAggregateBar)) == 2


def test_old_products_preserve_history_and_active_refs(runtime):
    contract_old_products_preserve_history_and_active_refs(runtime)


def test_expired_inputs_are_unavailable(database, monkeypatch):
    composite, active, seam = populated(database, monkeypatch)
    future = seam + 40 * 86400000
    with database() as db:
        assert list(composite_inputs.rows(db, active, seam, seam + 600000, now=future)) == []
        from alerts.composite_chart import chart_page
        page = chart_page(db, composite, "M1", now=future)
        assert all(bar["end"] <= seam for bar in page["bars"])


def test_long_outage_recovery_never_requests_expired_input(database, monkeypatch):
    from alerts import live_pricing as live
    from alerts.storage import LiveState
    from test_live_pricing import running

    context = running.__wrapped__(database, monkeypatch)
    factory, ownership, epoch, identities = context
    identity = identities["EUR_USD"]
    stamp = 40 * 86400000
    monkeypatch.setattr(live, "lock_owner", lambda *args, **kwargs: None)
    with factory.begin() as db:
        state = db.get(LiveState, identity.key)
        state.recovery_cursor, state.ready, state.next_confirm_at = 0, False, 0
    start, end = live.confirmation_window(ownership, epoch, identity, now=stamp)
    assert start == stamp - window.WINDOW_MS
    assert start < end <= start + 240 * 60000


def test_old_candidate_and_preparation_rejected(database, monkeypatch):
    composite, active, seam = populated(database,monkeypatch)
    publish(database,end=198960000)
    future=200010000+40*86400000
    monkeypatch.setattr('alerts.composite_revisions.now_ms',lambda:future)
    monkeypatch.setattr('alerts.composite_preparation.now_ms',lambda:future)
    with database() as db:
        plan=baseline_shadow.candidate_plan(db,composite)
    assert plan.get('blocked',{}).get('code') == 'history_outside_live_window'
    assert composite_preparation.claim(active) is None
    with database() as db:
        assert db.get(CompositePreparation,active).error == 'live_window_expired'


def test_failed_shadow_notifies_once(database,monkeypatch):
    composite,active,seam=populated(database,monkeypatch)
    monkeypatch.setattr(baseline_shadow,'latest_version',lambda *_:None)
    first=baseline_shadow.shadow(composite,scheduled_for=200010000)
    second=baseline_shadow.shadow(composite,scheduled_for=200010000)
    assert first['run']['id']==second['run']['id']
    with database() as db:
        assert db.scalar(select(func.count()).select_from(Notification)) == 1
        assert db.scalar(select(func.count()).select_from(Outbox)) == 1


def test_shadow_failure_pauses_only_expired_binding(database, monkeypatch):
    from alerts.storage import ChartAlert, CompositeRevision
    from test_switch_activation import candidate, rules

    composite, old, ident, _ = candidate(database, monkeypatch)
    old_rule, valid_rule = rules(database, monkeypatch, composite, old, ident)
    with database() as db:
        seam = db.get(CompositeRevision, old).seam
        assert db.get(CompositeRevision, ident).seam > seam
    future = seam + window.WINDOW_MS + 1
    monkeypatch.setattr("alerts.live_window.now_ms", lambda: future)
    monkeypatch.setattr(baseline_shadow, "now_ms", lambda: future)
    monkeypatch.setattr(baseline_shadow, "latest_version", lambda *_: None)
    report = baseline_shadow.shadow(composite, scheduled_for=future)
    assert not report["ready"]
    with database() as db:
        assert db.get(ChartAlert, old_rule).status == "paused"
        assert db.get(ChartAlert, valid_rule).status == "active"


def test_superseded_candidate_stops_fanout(database,monkeypatch):
    composite,old,body=revisions.request(database,monkeypatch)
    with database.begin() as db:
        first=revisions.create(db,composite,body).id
        second=revisions.create(db,composite,{**body,'request_id':'loser','seam':body['seam']+60000}).id
    revisions.prepared(database,first)
    revisions.prepared(database,second)
    with database.begin() as db:
        revisions.activate(db,composite,first,{'request_id':'winner','expected_revision_id':old})
        before=db.get(CompositePreparation,second).input_revision
    late_batch(database,first,200040000)
    with database() as db:
        assert composite_inputs.frozen(db.get(CompositePreparation,second))
        assert db.get(CompositePreparation,second).input_revision == before


def test_rule_lock_is_scoped(database):
    from alerts.storage import ChartAlert, ChartAlertVersion
    with database.begin() as db:
        for name in ('a','b'):
            db.add(ChartAlert(id=name,request_id=name,request_hash=name,name=name,status='active',effective_at=1))
            db.add(ChartAlertVersion(alert_id=name,version=1,config={},market_identity={'composite_id':name},effective_at=1))
    statements=[]
    def capture(conn,cursor,statement,parameters,context,executemany):
        statements.append(statement)
    engine=database.kw['bind']
    event.listen(engine,'before_cursor_execute',capture)
    try:
        with database.begin() as db:
            assert len(composite_alerts.bound_rules(db,'a',lock=True))==1
    finally:
        event.remove(engine,'before_cursor_execute',capture)
    assert any('JSON_EXTRACT' in query and 'WHERE' in query for query in statements)
