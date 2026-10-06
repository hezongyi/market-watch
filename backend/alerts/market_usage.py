"""Read the durable demand graph without creating series or contacting suppliers."""

from sqlalchemy import or_, select

from .storage import (
    ChartAlert,
    ChartAlertVersion,
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
    wanted.update(row.config.get("instrument") for row in versions if row.config.get("instrument"))
    return wanted


def composite_targets(db, wanted):
    return set(db.scalars(select(RealtimeMapping.target_dataset_id).join(
        MarketComposite, MarketComposite.mapping_id == RealtimeMapping.id
    ).where(MarketComposite.instrument_id.in_(wanted)))) if wanted else set()
