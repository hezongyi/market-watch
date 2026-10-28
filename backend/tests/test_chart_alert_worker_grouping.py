"""One shared read and one transaction per composite revision group."""

from alerts import chart_alert_worker, composite_alerts, composite_quotes
from alerts.chart_alert_service import AlertConfig, create, current_version
from alerts.chart_alert_worker import step
from alerts.storage import ChartAlert, SignalRow
from sqlalchemy import event, func, select
from test_composite_alerts import append, ready_config


def rules(database, make, count, prefix):
    with database.begin() as db:
        return [create(db, f"{prefix}-{index}", AlertConfig.model_validate(make()), at=make.at).id
                for index in range(count)]


def group_reads(monkeypatch):
    """Record how many rules each shared composite read covered."""
    seen, real = [], composite_alerts.shared_context

    def counted(db, identities, now, *, clock=None):
        seen.append(len(identities))
        return real(db, identities, now, clock=clock)

    monkeypatch.setattr(composite_alerts, "shared_context", counted)
    return seen


def revision_of(database, ident):
    with database.begin() as db:
        return current_version(db, db.get(ChartAlert, ident)).market_identity["composite_revision_id"]


def test_group_takes_one_dataset_lock_and_one_live_snapshot(database, monkeypatch):
    make = ready_config(database, monkeypatch)
    idents = rules(database, make, 2, "shared-read")
    snapshots = []
    original = composite_quotes.live_snapshot

    def counted(*args, **kwargs):
        snapshots.append(args)
        return original(*args, **kwargs)

    monkeypatch.setattr(composite_quotes, "live_snapshot", counted)
    with database() as db:
        engine = db.get_bind()
    locks = []

    def record(_conn, _cursor, statement, _parameters, _context, _many):
        if "FROM market_datasets" in statement and " IN (" in statement:
            locks.append(statement)

    event.listen(engine, "before_cursor_execute", record)
    try:
        assert step(now=make.at) == len(idents)
    finally:
        event.remove(engine, "before_cursor_execute", record)
    # Two rules, one revision: the dataset locks and the live snapshot are read once.
    assert len(snapshots) == 1
    assert len(locks) == 1
    with database() as db:
        assert [db.get(ChartAlert, ident).health for ident in idents] == ["ready", "ready"]


def test_one_rule_failure_rolls_back_only_its_own_savepoint(database, monkeypatch):
    make = ready_config(database, monkeypatch)
    failing, healthy = rules(database, make, 2, "savepoint")
    reads = group_reads(monkeypatch)
    order, real = [], chart_alert_worker.evaluate

    def evaluate_rule(db, ident, **kwargs):
        order.append(ident)
        if ident == failing:
            raise RuntimeError("controlled failure")
        return real(db, ident, **kwargs)

    monkeypatch.setattr(chart_alert_worker, "evaluate", evaluate_rule)
    assert step(now=make.at) == 1
    # The healthy rule judged after the failure from the same group transaction.
    assert reads == [2]
    assert order == [failing, healthy]
    with database() as db:
        broken, committed = db.get(ChartAlert, failing), db.get(ChartAlert, healthy)
        assert broken.health == "error" and "RuntimeError" in broken.health_reason
        assert broken.state == {} and broken.runtime == {}
        assert committed.health == "ready" and committed.runtime.get("input_revision") is not None


def test_rule_held_by_another_owner_is_skipped_and_the_group_continues(database, monkeypatch):
    make = ready_config(database, monkeypatch)
    held, free = rules(database, make, 2, "skip-locked")
    reads = group_reads(monkeypatch)
    real = chart_alert_worker._evaluate_rule

    def skip_owned(db, ident, **kwargs):
        if ident == held:
            return False, None  # The row fetch returned no rule this boot owns.
        return real(db, ident, **kwargs)

    monkeypatch.setattr(chart_alert_worker, "_evaluate_rule", skip_owned)
    assert step(now=make.at) == 1
    assert reads == [2]
    with database() as db:
        assert db.get(ChartAlert, held).health == "warming"
        assert db.get(ChartAlert, free).health == "ready"


def test_grouped_turn_keeps_the_events_of_one_transaction_per_rule(database, monkeypatch):
    make = ready_config(database, monkeypatch)
    idents = rules(database, make, 2, "equivalent")
    revision = revision_of(database, idents[0])
    assert step(now=make.at) == len(idents)
    with database() as db:
        crossing = db.get(ChartAlert, idents[0]).state["sequence"]
    original, real = composite_alerts.shared_context, composite_alerts.shared_context

    def group_read_unavailable(db, identities, now, *, clock=None):
        if len(identities) > 1:  # Only a grouped turn is taken out of the shared path.
            raise RuntimeError("shared read unavailable")
        return original(db, identities, now, clock=clock)

    for index, (close, fallback) in enumerate((("1.119", False), ("1.11", False), ("1.119", True))):
        start = crossing + index * 60_000
        now = start + 60_010
        append(database, revision, start, close, now)
        monkeypatch.setattr(composite_alerts, "shared_context",
                            group_read_unavailable if fallback else real)
        assert step(now=now) == len(idents)
    with database() as db:
        signals = list(db.scalars(select(SignalRow).order_by(SignalRow.occurred_at)))
        # Both crossings produced one event per rule, whichever transaction shape judged it.
        assert len(signals) == 4
        at = sorted({signal.occurred_at for signal in signals})
        assert len(at) == 2
        for occurred_at in at:
            window = [signal for signal in signals if signal.occurred_at == occurred_at]
            assert sorted(signal.chart_alert_id for signal in window) == sorted(idents)
            assert len({(signal.direction, signal.price, signal.threshold) for signal in window}) == 1
        shape = (signals[0].direction, signals[0].price, signals[0].threshold)
        assert (signals[2].direction, signals[2].price, signals[2].threshold) == shape
    # A repeated turn judges again without replaying the same event.
    assert step(now=crossing + 120_010) == len(idents)
    with database() as db:
        assert db.scalar(select(func.count()).select_from(SignalRow)) == 4