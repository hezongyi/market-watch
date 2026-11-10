"""Real task-owned PostgreSQL transactions; never use a shared writable schema."""

import importlib.util
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
import test_price_alert_close as close_contracts
import test_price_alert_inputs as contracts
import test_price_alert_settlement as settlement_contracts
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alerts.price_alert_inputs import prune, read_after
from alerts.storage import MarketDataset, PriceAlertInput, PriceAlertStream
from sqlalchemy import inspect, select
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"), reason="Requires task-owned PostgreSQL")


@pytest.mark.parametrize("contract", [
    close_contracts.test_close_backlog_ignores_current_quote_outage,
    close_contracts.test_sparse_m5_uses_bounded_query_without_faking_coverage,
    close_contracts.test_first_unresolved_period_blocks_later_confirmed_cross,
    close_contracts.test_failed_query_blocks_until_newer_success_covers_the_window,
    close_contracts.test_observed_unconfirmed_member_blocks_sparse_close,
    close_contracts.test_global_aggregation_lag_does_not_block_confirmed_older_range,
    close_contracts.test_correction_in_required_range_waits_for_aggregation,
    close_contracts.test_batch_limit_resumes_at_exact_next_period,
    close_contracts.test_pending_latest_baseline_correction_blocks_future_comparison,
    close_contracts.test_creation_with_old_seam_uses_verified_current_materialization,
    close_contracts.test_create_without_confirmed_baseline_first_future_close_is_only_baseline,
    close_contracts.test_monthly_materialization_with_truncated_start_is_explicitly_blocked,
    close_contracts.test_expired_failure_evidence_cannot_silently_certify_old_bar,
])
def test_close_contract(provider_pg, monkeypatch, contract):
    contract(provider_pg[0], monkeypatch)


@pytest.mark.parametrize("latest", [False, True])
def test_close_correction(provider_pg, monkeypatch, latest):
    close_contracts.test_corrections_preserve_events_and_only_rebase_affected_latest_close(provider_pg[0], monkeypatch, latest)


@pytest.mark.parametrize("frame", ["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN"])
def test_close_period(provider_pg, monkeypatch, frame):
    close_contracts.test_all_existing_periods_use_source_confirmed_sparse_close(provider_pg[0], monkeypatch, frame)


@pytest.mark.parametrize("mode", ["intrabar", "close"])
def test_expiry_valid_input(provider_pg, monkeypatch, mode):
    settlement_contracts.test_expiry_saves_valid_delayed_signal_without_restarting_demand(provider_pg[0], monkeypatch, mode)


@pytest.mark.parametrize("mode", ["intrabar", "close"])
def test_expiry_boundary(provider_pg, monkeypatch, mode):
    settlement_contracts.test_event_at_exact_expiry_never_triggers(provider_pg[0], monkeypatch, mode)


@pytest.mark.parametrize("contract", [
    settlement_contracts.test_worker_resumes_expired_fixed_close_version_in_finite_batches,
    settlement_contracts.test_failure_before_settlement_commit_retries_same_inputs,
    settlement_contracts.test_intrabar_expiry_can_resume_multiple_batches,
    settlement_contracts.test_settlement_respects_remaining_trigger_count,
    settlement_contracts.test_expired_close_finishes_unresolved_window_and_never_waits_for_future_repair,
    settlement_contracts.test_expiry_during_dataset_lock_wait_still_settles_real_detected_time,
])
def test_settlement_contract(provider_pg, monkeypatch, contract):
    contract(provider_pg[0], monkeypatch)


@pytest.mark.parametrize("action", ["pause", "archive"])
def test_settlement_cancel(provider_pg, monkeypatch, action):
    settlement_contracts.test_user_lifecycle_cancels_pending_settlement(provider_pg[0], monkeypatch, action)


@pytest.fixture
def collecting(provider_pg, monkeypatch):
    return contracts.collecting.__wrapped__(provider_pg[0], monkeypatch)


@pytest.mark.parametrize("contract", [
    contracts.test_same_millisecond_prices_have_distinct_sequences_and_replay_is_noop,
    contracts.test_retention_loss_boundary_survives_deletion_and_transaction_rollback,
    contracts.test_disconnect_persists_marker_in_the_same_transaction,
    contracts.test_rest_samples_keep_receive_time_contract_and_mode_boundary,
])
def test_collection_contract(collecting, contract):
    contract(collecting)


def test_atomic_collection_failure(collecting, monkeypatch):
    contracts.test_log_failure_rolls_back_latest_snapshot_and_sequence(collecting, monkeypatch)


def test_collector_and_pruner_share_dataset_then_stream_lock_order(collecting):
    factory, _, identity, _, stamp = collecting
    contracts.publish(collecting, 1, "1.110")

    def collect():
        for seq in range(2, 20):
            contracts.publish(collecting, seq, "1.110")

    def clean():
        for _ in range(20):
            with factory.begin() as db:
                prune(db, identity.key, now=stamp + 2000, max_rows=4)

    with ThreadPoolExecutor(max_workers=2) as pool:
        tasks = [pool.submit(collect), pool.submit(clean)]
        for task in tasks:
            task.result(timeout=30)
    with factory.begin() as db:
        stream = db.get(PriceAlertStream, identity.key)
        rows = read_after(db, identity.key, stream.trimmed_through)
        assert stream.sequence == 19
        assert [r.sequence for r in rows] == list(range(stream.trimmed_through + 1, 20))


def test_additive_migration_preserves_existing_dataset(provider_pg):
    _, engine = provider_pg
    file = Path(__file__).resolve().parents[2] / "migrations/versions/bc56_price_alert_inputs.py"
    spec = importlib.util.spec_from_file_location("price_input_migration", file)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    with engine.begin() as conn:
        before = list(conn.execute(select(MarketDataset.id)))
        PriceAlertInput.__table__.drop(conn)
        PriceAlertStream.__table__.drop(conn)
        migration.op = Operations(MigrationContext.configure(conn))
        migration.upgrade()
        assert {"price_alert_streams", "price_alert_inputs"} <= set(inspect(conn).get_table_names())
        assert list(conn.execute(select(MarketDataset.id))) == before
        with pytest.raises(RuntimeError, match="pause price-v2"):
            migration.downgrade()


def test_first_rule_registration_serializes_with_collection(provider_pg, monkeypatch):
    from alerts import live_pricing, price_alert_inputs
    from alerts.chart_alert_service import create, current_version
    from alerts.chart_alert_worker import evaluate
    from alerts.market_contracts import DatasetIdentity
    from alerts.storage import ChartAlert, CompositeRevision, LiveState, RealtimeMapping
    from test_composite_alerts import ready_config
    from test_live_pricing import quote

    factory, _ = provider_pg
    make = ready_config(factory, monkeypatch)
    config = make(mode="intrabar")
    with factory.begin() as db:
        revision = db.get(CompositeRevision, config.composite_revision_id)
        target = db.get(RealtimeMapping, revision.mapping_id).target_dataset_id
        identity = DatasetIdentity.model_validate(db.get(MarketDataset, target).identity)
        state = db.get(LiveState, target)
        state.quote = {**state.quote, "sequence": 0, "received_at": make.at}
        assert db.get(PriceAlertStream, target) is None
    registered, release, collecting_started = threading.Event(), threading.Event(), threading.Event()
    original = price_alert_inputs.register

    def gated(*args, **kwargs):
        result = original(*args, **kwargs)
        if not registered.is_set():
            registered.set()
            assert release.wait(10)
        return result

    monkeypatch.setattr(price_alert_inputs, "register", gated)
    monkeypatch.setattr("alerts.price_alert_evaluator.register", gated)

    def create_rule():
        with factory.begin() as db:
            return create(db, "first-price-rule", config, at=make.at).id

    def collect():
        collecting_started.set()
        owner = (live_pricing.account_key(live_pricing.settings.oanda_account_id), "test-owner")
        return live_pricing.publish_event(owner, 1, quote(identity, 1, seq=1,
            source=make.at + 100, received_at=make.at + 100, bid="1.120"),
            {"EUR_USD": identity}, now=make.at + 100)

    with ThreadPoolExecutor(max_workers=2) as pool:
        creation = pool.submit(create_rule)
        assert registered.wait(10)
        collection = pool.submit(collect)
        try:
            assert collecting_started.wait(10)
            assert not collection.done()
        finally:
            release.set()
        ident = creation.result(timeout=15)
        assert collection.result(timeout=15) == "accepted"
    with factory.begin() as db:
        alert = db.get(ChartAlert, ident)
        assert current_version(db, alert).market_identity["target_dataset_id"] == target
        assert alert.runtime["cursor"] == 0
        assert [row.price for row in read_after(db, target, 0)] == ["1.120"]
        assert len(evaluate(db, ident, now=make.at + 200)) == 1


def test_signal_cursor_count_and_notification_rollback_together(collecting):
    from alerts.chart_alert_worker import evaluate
    from alerts.storage import ChartAlert, Notification, SignalRow
    from sqlalchemy import func

    factory, ident, _, _, stamp = collecting
    contracts.publish(collecting, 1, "1.120")
    with pytest.raises(RuntimeError, match="before commit"):
        with factory.begin() as db:
            assert len(evaluate(db, ident, now=stamp + 200)) == 1
            raise RuntimeError("before commit")
    with factory.begin() as db:
        assert db.get(ChartAlert, ident).runtime["cursor"] == 0
        assert db.get(ChartAlert, ident).count == 0
        assert db.scalar(select(func.count()).select_from(SignalRow)) == 0
        assert db.scalar(select(func.count()).select_from(Notification)) == 0
        assert len(evaluate(db, ident, now=stamp + 200)) == 1
    with factory.begin() as db:
        assert evaluate(db, ident, now=stamp + 300) == []
        assert db.get(ChartAlert, ident).count == 1
        assert db.get(ChartAlert, ident).runtime["cursor"] == 1
        assert db.scalar(select(func.count()).select_from(SignalRow)) == 1


@pytest.mark.parametrize("contract", [
    contracts.test_hard_dataset_limit_without_evaluator_and_recovery_boundary,
    contracts.test_global_limit_prefers_acknowledged_data_across_datasets,
    contracts.test_rest_logging_does_not_depend_on_display_capacity,
    contracts.test_verified_closure_preserves_baseline_across_connection_change,
    contracts.test_age_limit_is_applied_before_evaluation_even_without_periodic_cleanup,
])
def test_retention_and_continuity_contract(collecting, monkeypatch, contract):
    contract(collecting, monkeypatch)


def test_periodic_retention_without_new_collection(collecting):
    contracts.test_retention_reclaims_acknowledged_inputs_and_age_without_new_quotes(collecting)


def test_resume_starts_at_current_baseline_after_no_demand(collecting):
    contracts.test_resume_after_idle_registration_does_not_lose_first_future_cross(collecting)


def test_cleanup_waits_for_consumer_transaction_before_deleting(collecting):
    from alerts.chart_alert_worker import evaluate
    from alerts.storage import ChartAlert, SignalRow
    from sqlalchemy import func

    factory, ident, identity, _, stamp = collecting
    contracts.publish(collecting, 1, "1.120")
    consumed, release, pruning = threading.Event(), threading.Event(), threading.Event()

    def consume():
        with factory.begin() as db:
            assert len(evaluate(db, ident, now=stamp + 200)) == 1
            consumed.set()
            assert release.wait(10)

    def clean():
        with factory.begin() as db:
            pruning.set()
            return prune(db, identity.key, now=stamp + 300, max_rows=0)

    with ThreadPoolExecutor(max_workers=2) as pool:
        evaluation = pool.submit(consume)
        assert consumed.wait(10)
        cleanup = pool.submit(clean)
        try:
            assert pruning.wait(10)
            assert not cleanup.done()
        finally:
            release.set()
        evaluation.result(timeout=10)
        assert cleanup.result(timeout=10) == 1
    with factory.begin() as db:
        assert db.get(ChartAlert, ident).runtime["cursor"] == 1
        assert db.scalar(select(func.count()).select_from(SignalRow)) == 1
        assert db.get(PriceAlertStream, identity.key).trimmed_through == 1
        assert evaluate(db, ident, now=stamp + 400) == []


def test_populated_alembic_upgrade_and_rc1_evaluator_rollback_fence(monkeypatch, tmp_path):
    """Run the original evaluator on both sides of a real additive upgrade."""
    import json
    import subprocess
    import sys
    import tarfile
    from io import BytesIO
    from uuid import uuid4

    from alembic import command
    from alembic.config import Config
    from alerts import storage
    from alerts.chart_alert_worker import evaluate
    from alerts.config import settings
    from alerts.storage import (
        Audit,
        ChartAlert,
        ChartAlertVersion,
        CompositeJudgment,
        Outbox,
        SignalRow,
    )
    from sqlalchemy import create_engine, text
    from sqlalchemy.engine import make_url
    from sqlalchemy.orm import sessionmaker

    root = Path(__file__).resolve().parents[2]
    baseline = "ef57bed61f66715a4c5ec2797f9abd67cb23d2fb"
    old = tmp_path / "rc1"
    old.mkdir()
    archive = subprocess.check_output(["git", "archive", baseline, "backend", "migrations",
        "alembic.ini"], cwd=root)
    with tarfile.open(fileobj=BytesIO(archive)) as checkout:
        checkout.extractall(old, filter="data")
    admin = create_engine(os.environ["TEST_POSTGRES_URL"])
    schema = "price_upgrade_" + uuid4().hex
    url = make_url(os.environ["TEST_POSTGRES_URL"]).update_query_dict({"options": "-csearch_path=" + schema})
    url_str = url.render_as_string(hide_password=False)
    with admin.begin() as conn:
        conn.execute(text(f"CREATE SCHEMA {schema}"))
    engine = create_engine(url)

    def old_python(code, **params):
        run = subprocess.run([sys.executable, "-"], cwd=old, text=True, input=code,
            env={**os.environ, "PYTHONPATH": os.pathsep.join((str(old / "backend"), str(old / "backend/tests"))),
                "ALERTS_DATABASE_URL": url_str, **params}, capture_output=True, timeout=90)
        assert run.returncode == 0, run.stderr
        return json.loads(run.stdout.splitlines()[-1])

    def revision():
        with engine.connect() as conn:
            return conn.scalar(text("SELECT version_num FROM alembic_version"))

    def history(db):
        models = (ChartAlertVersion, CompositeJudgment, SignalRow, Outbox)
        return {model.__tablename__: {row.id: tuple(getattr(row, field.name)
                for field in model.__table__.columns) for row in db.scalars(select(model))}
                for model in models}

    try:
        seeded = old_python("""
import json
from alembic import command
from alembic.config import Config
from alerts.chart_alert_service import create, current_version, lifecycle
from alerts.chart_alert_worker import evaluate
from alerts.config import settings
from alerts.live_pricing import account_key, publish_event
from alerts.market_contracts import DatasetIdentity, QuoteEvent
from alerts.storage import ChartAlert, LiveState, bootstrap, transaction, Session
from pytest import MonkeyPatch
from test_composite_alerts import append, armed, config

command.upgrade(Config('alembic.ini'), 'head')
bootstrap()
with MonkeyPatch.context() as patch:
    close, composite, revision, seam, stamp = armed(Session, patch, notify_ntfy=True)
    with transaction() as db:
        evaluate(db, close, now=stamp)
        ids = {'active_close': close}
        for label in ('active_touch', 'paused', 'legacy_hold', 'expired', 'archived', 'completed'):
            cfg = config(composite, mode='intrabar' if label == 'active_touch' else 'close',
                expires_at=stamp + 1000 if label == 'expired' else None)
            if label == 'completed':
                cfg = cfg.model_copy(update={'max_triggers': 1})
            alert = create(db, 'legacy:' + label, cfg, at=stamp)
            ids[label] = alert.id
            if label == 'legacy_hold':
                alert.status, alert.runtime = 'paused', {'demand_hold': 'stale_input'}
            elif label in ('paused', 'archived'):
                lifecycle(db, alert.id, alert.version, 'pause' if label == 'paused' else 'archive',
                    expected_revision=alert.control_revision, request_id=label, at=stamp + 1)
            elif label == 'completed':
                evaluate(db, alert.id, now=stamp)
        identity = DatasetIdentity.model_validate(current_version(db,
            db.get(ChartAlert, ids['active_touch'])).market_identity['target_identity'])
        state = db.get(LiveState, identity.key)
        state.quote = {**state.quote, "sequence": 0, "received_at": stamp}
        evaluate(db, ids['expired'], now=stamp + 1000)
    assert publish_event((account_key(settings.oanda_account_id), 'test-owner'), 1,
        QuoteEvent(identity=identity, source_time=stamp, received_at=stamp, bid='1.1101',
            ask='1.111', connection_epoch=1, sequence=1, tradeable=True),
        {'EUR_USD': identity}, now=stamp) == 'accepted'
    with transaction() as db:
        evaluate(db, ids['active_touch'], now=stamp)
        row = db.get(ChartAlert, ids['active_touch'])
        assert row.state.get('sequence'), (row.health, row.health_reason)
    end = seam + 660000
    append(Session, revision, seam + 600000, '1.119', end + 10)
    with transaction() as db:
        assert len(evaluate(db, close, now=end + 10)) == 1
        assert len(evaluate(db, ids['completed'], now=end + 10)) == 1
        assert db.get(ChartAlert, ids['completed']).status == 'completed'
    print(json.dumps({'ids': ids, 'at': end + 10}))
""")
        assert revision() == "bb55_provider_catalog_indexes"
        ids, stamp = seeded["ids"], seeded["at"]
        factory = sessionmaker(engine, expire_on_commit=False)
        monkeypatch.setattr(storage, "Session", factory)
        monkeypatch.setattr(settings, "database_url", url_str)
        monkeypatch.setattr(settings, "oanda_account_id", "composite-test-account")
        monkeypatch.setattr(settings, "oanda_token", "test-token")
        monkeypatch.setattr(settings, "ntfy_topic", "local-upgrade")
        monkeypatch.setattr(settings, "delivery_enabled", True)
        monkeypatch.setattr("alerts.live_window.now_ms", lambda: stamp)
        with factory() as db:
            before = history(db)
            cursor = db.get(ChartAlert, ids["active_close"]).state["sequence"]
            old_touch = db.get(ChartAlert, ids["active_touch"]).state["sequence"]
            assert before["outbox"] and before["composite_judgments"] and before["signals"]

        config = Config(str(root / "alembic.ini"))
        config.set_main_option("script_location", str(root / "migrations"))
        command.upgrade(config, "head")
        assert revision() == "bc56_price_alert_inputs"
        with factory.begin() as db:
            assert history(db) == before
            for name in ("active_close", "active_touch"):
                assert evaluate(db, ids[name], now=stamp) == []
            close = db.get(ChartAlert, ids["active_close"])
            touch = db.get(ChartAlert, ids["active_touch"])
            assert close.runtime["execution_contract"] == "price-v2" and close.runtime["close_cursor"] == cursor
            assert touch.runtime["cursor"] == 0 and old_touch != 0
            assert touch.runtime["last_gap"]["reason_code"] == "upgrade_boundary"
            for name, expected in (("paused", "paused"), ("legacy_hold", "paused"), ("expired", "expired"),
                                   ("archived", "archived"), ("completed", "completed")):
                assert db.get(ChartAlert, ids[name]).status == expected
        # Restarting the upgrade and evaluator must not append a second takeover gap.
        command.upgrade(config, "head")
        with factory.begin() as db:
            assert evaluate(db, ids["active_touch"], now=stamp + 1) == []
            gaps = db.scalars(select(Audit).where(Audit.kind == "chart_alert_unobserved",
                Audit.details["alert_id"].as_string() == ids["active_touch"])).all()
            assert [row.details["reason_code"] for row in gaps] == ["upgrade_boundary"]
            assert history(db) == before
            # New writers are quiescent; pause price-v2 without changing its checkpoint.
            db.execute(text("""
                UPDATE chart_alerts SET status = 'paused', control_revision = control_revision + 1
                WHERE status = 'active' AND runtime->>'execution_contract' = 'price-v2'
            """))
        checked = old_python("""
import json
import os
from alerts.chart_alert_worker import evaluate, step
from alerts.storage import ChartAlert, Outbox, SignalRow, transaction
from sqlalchemy import select

ids = json.loads(os.environ['LEGACY_IDS'])
stamp = int(os.environ['LEGACY_AT'])
assert step(now=stamp + 100) == 0
with transaction() as db:
    for name in ('active_close', 'active_touch'):
        row = db.get(ChartAlert, ids[name])
        assert row.status == 'paused' and evaluate(db, row.id, now=stamp + 100) == []
        assert row.runtime['execution_contract'] == 'price-v2'
    print(json.dumps({'signals': len(db.scalars(select(SignalRow)).all()),
                      'pending': len(db.scalars(select(Outbox).where(Outbox.status == 'pending')).all())}))
""", LEGACY_IDS=json.dumps(ids), LEGACY_AT=str(stamp))
        assert checked["signals"] == len(before["signals"]) and checked["pending"] == len(before["outbox"])
        assert revision() == "bc56_price_alert_inputs"
        with factory() as db:
            assert history(db) == before
    finally:
        engine.dispose()
        with admin.begin() as conn:
            conn.execute(text(f"DROP SCHEMA {schema} CASCADE"))
        admin.dispose()
