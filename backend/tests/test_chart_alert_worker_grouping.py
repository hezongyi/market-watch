"""One read-only baseline read per group; one transaction, lock and clock per rule."""

from contextlib import contextmanager
from types import SimpleNamespace

from alerts import chart_alert_worker, composite_alerts
from alerts.chart_alert_service import AlertConfig, create, current_version
from alerts.chart_alert_worker import step
from alerts.storage import ChartAlert, MarketDataset, SignalRow
from sqlalchemy import event, func, select, update
from test_composite_alerts import append, ready_config


def rules(database, make, count, prefix):
    with database.begin() as db:
        return [create(db, f"{prefix}-{index}", AlertConfig.model_validate(make()), at=make.at).id
                for index in range(count)]


def group_reads(monkeypatch):
    """Record how many identities each shared baseline read covered."""
    seen, real = [], composite_alerts.static_context

    def counted(db, identities):
        seen.append(len(identities))
        return real(db, identities)

    monkeypatch.setattr(composite_alerts, "static_context", counted)
    return seen


def revision_of(database, ident):
    with database.begin() as db:
        return current_version(db, db.get(ChartAlert, ident)).market_identity["composite_revision_id"]


def replaced_revision(context, **changes):
    """The turn's baseline as it would look if a revision had been replaced."""
    revision = context["revision"]
    return {**context, "revision": SimpleNamespace(id=revision.id, composite_id=revision.composite_id,
        history_version_id=revision.history_version_id, mapping_id=revision.mapping_id,
        rules=revision.rules, seam=revision.seam, **changes)}


def engine_of(database):
    with database() as db:
        return db.get_bind()


def test_one_static_read_per_group_one_lock_and_one_clock_per_rule(database, monkeypatch):
    make = ready_config(database, monkeypatch)
    idents = rules(database, make, 2, "shared-static")
    reads = group_reads(monkeypatch)
    events, stamps = [], []

    def clock():
        stamps.append(make.at + 1000 * (len(stamps) + 1))
        events.append("clock")
        return stamps[-1]

    monkeypatch.setattr(chart_alert_worker, "now_ms", clock)

    def record(_conn, _cursor, statement, _parameters, _context, _many):
        text = " ".join(statement.split())
        if "FROM market_datasets" in text and " IN (" in text:
            events.append("lock")

    reports = []
    engine = engine_of(database)
    event.listen(engine, "before_cursor_execute", record)
    try:
        assert step(on_evaluated=reports.append) == len(idents)
    finally:
        event.remove(engine, "before_cursor_execute", record)
    # One read-only baseline read covered every rule of the group.
    assert reads == [len(idents)]
    # Every rule read its own clock, then took its own dataset lock, then read
    # the clock again after the lock: no clock or state came from before it.
    assert events == ["clock", "lock", "clock"] * len(idents)
    assert [row["business_now"] for row in reports] == stamps[1::2]
    assert {row["alert_id"] for row in reports} == set(idents)
    with database() as db:
        assert [db.get(ChartAlert, ident).health for ident in idents] == ["ready"] * len(idents)


def test_shared_baseline_outlives_the_read_only_transaction(database, monkeypatch):
    make = ready_config(database, monkeypatch)
    rules(database, make, 2, "detached")
    revision_id, members = chart_alert_worker._active_groups()[0]
    static = chart_alert_worker._static_read(revision_id, members)
    # The rows stay usable after the read-only transaction closed: the session
    # factory must keep loaded attributes (expire_on_commit=False), otherwise
    # every rule would pay to reload what the turn already read.
    assert static["revision"].rules and static["history"].manifest is not None
    assert static["target"].identity["account_scope"] == composite_alerts.account_scope()
    assert static["target_instrument"].calendar_profile is not None


def test_baseline_that_no_longer_matches_the_rule_is_read_again_for_it(database, monkeypatch):
    make = ready_config(database, monkeypatch)
    idents = rules(database, make, 2, "rebound")
    seen, real = [], composite_alerts.static_context

    def rebound(db, identities):
        context = real(db, identities)
        seen.append(len(identities))
        # A revision replaced after the turn was planned: the shared row no
        # longer carries the seam this rule was bound to.
        return replaced_revision(context, seam=context["revision"].seam + 60_000) if len(seen) == 1 else context

    monkeypatch.setattr(composite_alerts, "static_context", rebound)
    assert step(now=make.at) == len(idents)
    # The stale baseline was dropped and each rule read its own: one group read
    # plus one read per rule, never a judgment drawn from the stale copy.
    assert seen == [len(idents), 1, 1]
    with database() as db:
        assert [db.get(ChartAlert, ident).health for ident in idents] == ["ready"] * len(idents)


def test_dataset_replaced_after_the_shared_read_falls_back_to_a_reading_rule(database, monkeypatch):
    make = ready_config(database, monkeypatch)
    idents = rules(database, make, 2, "switched")
    seen, real = [], composite_alerts.static_context

    def switched(db, identities):
        context = real(db, identities)
        seen.append(len(identities))
        if len(seen) == 1:
            # The locked row this turn took no lock on changes after the read.
            db.execute(update(MarketDataset).where(MarketDataset.id == context["target"].id).values(
                identity={**context["target"].identity, "account_scope": "switched-account"}))
        return context

    monkeypatch.setattr(composite_alerts, "static_context", switched)
    assert step(now=make.at) == len(idents)
    assert seen == [len(idents), 1, 1]
    with database() as db:
        for ident in idents:
            row = db.get(ChartAlert, ident)
            # The rule refuses the replaced mapping instead of judging on the
            # baseline the shared read saw before the switch.
            assert row.health == "blocked" and "固定组合基线" in row.health_reason


def test_one_rule_failure_never_takes_another_rule_down_with_it(database, monkeypatch):
    make = ready_config(database, monkeypatch)
    failing, healthy = rules(database, make, 2, "isolated")
    reads = group_reads(monkeypatch)
    order, real = [], chart_alert_worker.evaluate

    def evaluate_rule(db, ident, **kwargs):
        order.append(ident)
        if ident == failing:
            raise RuntimeError("controlled failure")
        return real(db, ident, **kwargs)

    monkeypatch.setattr(chart_alert_worker, "evaluate", evaluate_rule)
    assert step(now=make.at) == 1
    # The group baseline still served both rules; only the failing one lost its work.
    assert reads == [len(order)]
    assert order == [failing, healthy]
    with database() as db:
        broken, committed = db.get(ChartAlert, failing), db.get(ChartAlert, healthy)
        assert broken.health == "error" and "RuntimeError" in broken.health_reason
        assert broken.state == {} and broken.runtime == {}
        assert committed.health == "ready" and committed.runtime.get("input_revision") is not None


def test_rule_held_by_another_owner_is_skipped_and_the_turn_continues(database, monkeypatch):
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


def test_no_transaction_ever_covers_a_second_rule(database, monkeypatch):
    make = ready_config(database, monkeypatch)
    idents = rules(database, make, 2, "own-transaction")
    events, depth = [], [0]
    real_transaction = chart_alert_worker.transaction

    @contextmanager
    def tracked():
        depth[0] += 1
        assert depth[0] == 1, "a transaction spans more than one rule"
        events.append("begin")
        try:
            with real_transaction() as db:
                yield db
        finally:
            events.append("end")
            depth[0] -= 1

    real_evaluate = chart_alert_worker.evaluate

    def evaluate_rule(db, ident, **kwargs):
        events.append(("judge", ident))
        return real_evaluate(db, ident, **kwargs)

    monkeypatch.setattr(chart_alert_worker, "transaction", tracked)
    monkeypatch.setattr(chart_alert_worker, "evaluate", evaluate_rule)
    assert step(now=make.at) == len(idents)
    # The active-rule list and the shared baseline read commit before any
    # judgment; each judgment has its own transaction, so none of them can hold
    # another rule's work.
    assert events == ["begin", "end", "begin", "end", "begin", ("judge", idents[0]), "end",
                      "begin", ("judge", idents[1]), "end"]


def test_a_rule_judged_from_a_discarded_baseline_still_reports_the_same_events(database, monkeypatch):
    make = ready_config(database, monkeypatch)
    idents = rules(database, make, 2, "equivalent")
    revision = revision_of(database, idents[0])
    assert step(now=make.at) == len(idents)
    with database() as db:
        crossing = db.get(ChartAlert, idents[0]).state["sequence"]
    real = composite_alerts.static_context

    def discarded_group_context(db, identities):
        context = real(db, identities)
        # Only a grouped turn loses its baseline; the per-rule read stays real.
        return replaced_revision(context, seam=context["revision"].seam + 60_000) if len(identities) > 1 else context

    for index, (close, discarded) in enumerate((("1.119", False), ("1.11", False), ("1.119", True))):
        now = crossing + index * 60_000 + 60_010
        append(database, revision, crossing + index * 60_000, close, now)
        monkeypatch.setattr(composite_alerts, "static_context",
                            discarded_group_context if discarded else real)
        assert step(now=now) == len(idents)
    with database() as db:
        signals = list(db.scalars(select(SignalRow).order_by(SignalRow.occurred_at)))
        # Both crossings produced one event per rule, whichever read judged it.
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
