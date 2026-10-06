"""Read the durable demand graph without creating series or contacting suppliers."""

from sqlalchemy import or_, select

from .storage import (
    ChartAlert,
    ChartAlertVersion,
    CompositeRevision,
    CompositeWatchBinding,
    MarketComposite,
    MarketDemand,
    RealtimeMapping,
    Watch,
    now_ms,
)


def wanted_instruments(db, *, now=None):
    stamp = now_ms() if now is None else now
    wanted = set(db.scalars(select(Watch.instrument_id).where(Watch.status == "active")))
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
    targets, fixed_consumers = set(), set()
    for binding, watch in db.execute(select(CompositeWatchBinding, Watch).join(
            Watch, Watch.id == CompositeWatchBinding.watch_id).where(Watch.status == "active")):
        targets.add(binding.market_identity["target_dataset_id"])
        fixed_consumers.add(watch.instrument_id)
    for version in db.scalars(select(ChartAlertVersion).join(ChartAlert, (
        ChartAlertVersion.alert_id == ChartAlert.id) & (ChartAlertVersion.version == ChartAlert.version)
    ).where(ChartAlert.status == "active", or_(ChartAlert.expires_at.is_(None), ChartAlert.expires_at > stamp))):
        if version.config.get("series_kind") == "composite":
            targets.add(version.market_identity["target_dataset_id"])
            fixed_consumers.add(version.market_identity["instrument_id"])
    # A fixed rule alone must not subscribe a newly activated chart target.
    # Only actual chart demand (or pre-binding legacy consumers) follows head.
    chart_consumers = set(db.scalars(select(MarketDemand.instrument_id).where(MarketDemand.expires > stamp)))
    active_consumers = (wanted - fixed_consumers) | (wanted & chart_consumers)
    if active_consumers:
        targets.update(db.scalars(select(RealtimeMapping.target_dataset_id).join(
            CompositeRevision, CompositeRevision.mapping_id == RealtimeMapping.id).join(
            MarketComposite, MarketComposite.active_revision_id == CompositeRevision.id
        ).where(MarketComposite.instrument_id.in_(active_consumers))))
    return targets
