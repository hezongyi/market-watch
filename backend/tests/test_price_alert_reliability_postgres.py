"""Real task-owned PostgreSQL transactions; never use a shared writable schema."""

import importlib.util
import os
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
import test_price_alert_inputs as contracts
from alembic.migration import MigrationContext
from alembic.operations import Operations
from alerts.price_alert_inputs import prune, read_after
from alerts.storage import MarketDataset, PriceAlertInput, PriceAlertStream
from sqlalchemy import inspect, select
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"), reason="Requires task-owned PostgreSQL")


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
