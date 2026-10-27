"""Read the durable demand graph without creating series or contacting suppliers."""

from sqlalchemy import or_, select

from .storage import (
    ChartAlert,
    ChartAlertVersion,
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
