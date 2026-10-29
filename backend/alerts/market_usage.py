"""Read the durable demand graph without creating series or contacting suppliers."""

from sqlalchemy import or_, select

from .composite_inputs import frozen
from .storage import (
    ChartAlert,
    ChartAlertVersion,
    CompositePreparation,
    CompositeRevision,
    MarketComposite,
    MarketDemand,
    RealtimeMapping,
    now_ms,
)


def wanted_instruments(db, *, now=None):
    stamp = now_ms() if now is None else now
    wanted = set()
    wanted.update(db.scalars(select(MarketDemand.instrument_id).where(MarketDemand.expires > stamp)))
    versions = db.scalars(select(ChartAlertVersion).join(ChartAlert, (
        ChartAlertVersion.alert_id == ChartAlert.id) & (ChartAlertVersion.version == ChartAlert.version)
    ).where(ChartAlert.status == "active", or_(ChartAlert.expires_at.is_(None), ChartAlert.expires_at > stamp)))
    wanted.update(row.market_identity.get("instrument_id", row.config.get("instrument"))
                  for row in versions if row.config.get("instrument"))
    return wanted


def composite_targets(db, wanted):
    # Running rules may remain on an older revision/mapping after explicit
    # activation for charts; keep that exact target subscribed independently.
    stamp = now_ms()
    from .realtime_switch import revision_enabled

    targets, head_consumers = set(), set()
    for version in db.scalars(select(ChartAlertVersion).join(ChartAlert, (
        ChartAlertVersion.alert_id == ChartAlert.id) & (ChartAlertVersion.version == ChartAlert.version)
    ).where(ChartAlert.status == "active", or_(ChartAlert.expires_at.is_(None), ChartAlert.expires_at > stamp))):
        if version.config.get("series_kind") == "composite":
            revision = db.get(CompositeRevision, version.market_identity["composite_revision_id"])
            if revision and revision_enabled(db, revision):
                targets.add(version.market_identity["target_dataset_id"])
        else:
            head_consumers.add(version.market_identity.get("instrument_id", version.config.get("instrument")))
    # Each chart lease owns the revision actually read. Only legacy unbound
    # leases/rules follow head, including when a fixed consumer shares its ticker.
    demand_rows = db.execute(select(RealtimeMapping.target_dataset_id, CompositeRevision.id).join(
        CompositeRevision, CompositeRevision.mapping_id == RealtimeMapping.id).join(
        MarketDemand, MarketDemand.composite_revision_id == CompositeRevision.id
    ).where(MarketDemand.expires > stamp))
    targets.update(target for target, revision_id in demand_rows
                   if revision_enabled(db, db.get(CompositeRevision, revision_id)))
    held_rules = db.execute(select(ChartAlert, ChartAlertVersion).join(ChartAlertVersion, (
        ChartAlertVersion.alert_id == ChartAlert.id) & (ChartAlertVersion.version == ChartAlert.version)
    ).where(ChartAlert.status == "paused", ChartAlert.runtime["demand_hold"].as_string() == "stale_input",
        or_(ChartAlert.expires_at.is_(None), ChartAlert.expires_at > stamp)))
    for alert, version in held_rules:
        if version.config.get("series_kind") != "composite":
            continue
        revision_id = version.market_identity.get("composite_revision_id")
        revision = db.get(CompositeRevision, revision_id) if revision_id else None
        # A frozen revision ends its own acquisition demand. Only the case the
        # running revision needs the very same target keeps contributing it, where
        # the demand is one and the same rather than an extra one. A source switch
        # points at a different target, so the switched-away demand is dropped and
        # the shared source keeps serving every other valid consumer.
        if revision is None:
            continue
        if frozen(db.get(CompositePreparation, revision.id)):
            running = db.get(CompositeRevision, db.scalar(select(
                MarketComposite.active_revision_id).where(
                MarketComposite.id == revision.composite_id)) or "")
            if running is None or running.id == revision.id or db.scalar(
                    select(RealtimeMapping.target_dataset_id).where(
                        RealtimeMapping.id == running.mapping_id)) != db.scalar(
                    select(RealtimeMapping.target_dataset_id).where(
                        RealtimeMapping.id == revision.mapping_id)):
                continue
        if revision_enabled(db, revision):
            target = db.scalar(select(RealtimeMapping.target_dataset_id).where(
                RealtimeMapping.id == revision.mapping_id))
            if target:
                targets.add(target)
    head_consumers.update(db.scalars(select(MarketDemand.instrument_id).where(
        MarketDemand.expires > stamp, MarketDemand.composite_revision_id.is_(None))))
    active_consumers = wanted & head_consumers
    if active_consumers:
        rows = db.execute(select(RealtimeMapping.target_dataset_id, CompositeRevision.id).join(
            CompositeRevision, CompositeRevision.mapping_id == RealtimeMapping.id).join(
            MarketComposite, MarketComposite.active_revision_id == CompositeRevision.id
        ).where(MarketComposite.instrument_id.in_(active_consumers)))
        targets.update(target for target, revision_id in rows
                       if revision_enabled(db, db.get(CompositeRevision, revision_id)))
    return targets
