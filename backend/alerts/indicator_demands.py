"""Persistent, bounded foreground priority; cancellation is per consumer.

TTL is observed by worker SQL, not by browser cancellation. One of every four
claims reserves service for maintenance. Expiry never deletes shared results.
"""

from sqlalchemy import case, delete, exists, func, or_, select, text

from .source_history_store import _insert
from .storage import DisplaySnapshot, IndicatorDemand, IndicatorSchedule

TTL_MS = 30_000
MAX_CLIENT_DEMANDS = 64
MAX_DEMANDS = 256
MAX_PENDING_RUNS = 256
MAX_WARMUP_DEMANDS = 8
MAX_WARMUP_CONCURRENCY = 1  # per fixed/display worker role
MAINTENANCE_EVERY = 4


class DemandCapacity(ValueError):
    code = "INDICATOR_DEMAND_CAPACITY"

    def __init__(self):
        super().__init__("指标需求容量已满；关闭不用的图格或等待需求到期后重试")


def guard(db):
    if db.bind.dialect.name == "postgresql":
        db.execute(text("SELECT pg_advisory_xact_lock(8675313)"))


def renew(db, client, consumers, run, *, snapshot_id, start, end, stamp):
    from .chart_indicators import validate
    from .fixed_indicators import digest

    if not client or not consumers:
        return
    guard(db)
    db.execute(delete(IndicatorDemand).where(IndicatorDemand.expires <= stamp))
    client_key = digest(["client", client])
    for consumer in consumers:
        name, params = validate(consumer["spec"])
        if name != run.spec["name"] or params != run.spec["params"]:
            continue
        ident = digest([client_key, consumer["id"]])
        existing = db.get(IndicatorDemand, ident)
        generation = consumer["generation"]
        if existing and (
            existing.generation > generation
            or existing.generation == generation
            and existing.released
        ):
            continue
        purpose = consumer.get("purpose", "foreground")
        if not existing:
            total = db.scalar(select(func.count()).select_from(IndicatorDemand))
            own = db.scalar(
                select(func.count())
                .select_from(IndicatorDemand)
                .where(IndicatorDemand.client == client_key)
            )
            warm = db.scalar(
                select(func.count())
                .select_from(IndicatorDemand)
                .where(IndicatorDemand.purpose == "warmup")
            )
            if (
                total >= MAX_DEMANDS
                or own >= MAX_CLIENT_DEMANDS
                or purpose == "warmup"
                and warm >= MAX_WARMUP_DEMANDS
            ):
                raise DemandCapacity()
        # An edit replaces only this consumer's previous parameter demand.
        values = dict(
            id=ident,
            client=client_key,
            consumer=consumer["id"],
            run_id=run.id,
            snapshot_id=snapshot_id,
            start=start,
            end=end,
            purpose=purpose,
            expires=stamp + TTL_MS,
            generation=generation,
            released=False,
        )
        db.execute(
            _insert(db)(IndicatorDemand)
            .values(**values)
            .on_conflict_do_update(
                index_elements=["id"],
                set_={key: value for key, value in values.items() if key != "id"},
            )
        )


def release(db, client, consumers, *, stamp):
    from .fixed_indicators import digest

    guard(db)
    client_key = digest(["client", client])
    for consumer in consumers:
        ident = digest([client_key, consumer["id"]])
        current = db.get(IndicatorDemand, ident)
        if current and current.generation > consumer["generation"]:
            continue
        if (
            current is None
            and db.scalar(select(func.count()).select_from(IndicatorDemand)) >= MAX_DEMANDS
        ):
            # A new late renew is subject to the same full table budget.
            continue
        # A bounded tombstone also fences an HTTP request committing after
        # cancellation. Retain beyond the 30-second HTTP protection deadline.
        values = dict(
            id=ident,
            client=client_key,
            consumer=consumer["id"],
            run_id=None,
            snapshot_id=None,
            start=0,
            end=0,
            purpose="foreground",
            expires=stamp + 60_000,
            generation=consumer["generation"],
            released=True,
        )
        db.execute(
            _insert(db)(IndicatorDemand)
            .values(**values)
            .on_conflict_do_update(
                index_elements=["id"],
                set_={key: value for key, value in values.items() if key != "id"},
            )
        )


def priority(db, run_id, stamp, *, kind, snapshot_id=None):
    """A global persisted service turn survives worker replacement/restart."""
    db.execute(
        _insert(db)(IndicatorSchedule)
        .values(kind=kind, turn=0)
        .on_conflict_do_nothing(index_elements=["kind"])
    )
    schedule = db.scalar(
        select(IndicatorSchedule).where(IndicatorSchedule.kind == kind).with_for_update()
    )
    schedule.turn = (schedule.turn + 1) % MAINTENANCE_EVERY
    valid = select(IndicatorDemand.id).where(
        IndicatorDemand.run_id == run_id,
        IndicatorDemand.expires > stamp,
        IndicatorDemand.released.is_(False),
        or_(
            IndicatorDemand.snapshot_id.is_(None),
            IndicatorDemand.snapshot_id.in_(
                select(DisplaySnapshot.id).where(DisplaySnapshot.expires_at > stamp)
            ),
        ),
    )
    if snapshot_id is not None:
        valid = valid.where(IndicatorDemand.snapshot_id == snapshot_id)
    foreground = exists(valid.where(IndicatorDemand.purpose == "foreground"))
    warmup = exists(valid.where(IndicatorDemand.purpose == "warmup"))
    # Unrequested/expired work still gets bounded service and retains checkpoints.
    if schedule.turn == MAINTENANCE_EVERY - 1:
        return case((warmup, 0), (foreground, 1), else_=2)
    return (
        case((~foreground & ~warmup, 0), (foreground, 1), else_=2)
        if schedule.turn == 0
        else case((foreground, 0), (warmup, 2), else_=1)
    )


def warmup_capacity(model, run_id, stamp):
    warm = select(IndicatorDemand.run_id).where(
        IndicatorDemand.purpose == "warmup",
        IndicatorDemand.expires > stamp,
        IndicatorDemand.released.is_(False),
    )
    foreground = select(IndicatorDemand.run_id).where(
        IndicatorDemand.purpose == "foreground",
        IndicatorDemand.expires > stamp,
        IndicatorDemand.released.is_(False),
    )
    leased = (
        select(func.count())
        .select_from(model)
        .where(model.lease_until > stamp, run_id.in_(warm), run_id.not_in(foreground))
        .scalar_subquery()
    )
    return or_(run_id.not_in(warm), run_id.in_(foreground), leased < MAX_WARMUP_CONCURRENCY)


def warm_defaults(db, page, client, *, stamp):
    """At most two explicit specs per series; a full warm queue cannot block prices."""
    from .fixed_indicators import digest, request

    for name in ("SMA", "EMA"):
        try:
            with db.begin_nested():
                run = request(db, page, {"name": name, "params": {"period": 20}}, stamp=stamp)
                consumer = {
                    "id": "warm:"
                    + digest(
                        [page.get("revision_id"), page.get("version_id"), page["timeframe"], name]
                    ),
                    "generation": 0,
                    "spec": run.spec,
                    "purpose": "warmup",
                }
                renew(
                    db,
                    client,
                    [consumer],
                    run,
                    snapshot_id=page.get("display_snapshot_id"),
                    start=page["bars"][0]["start"],
                    end=page["bars"][-1]["end"],
                    stamp=stamp,
                )
        except DemandCapacity:
            return
