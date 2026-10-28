"""Managed real-time choice with compatible defaults and no history authorization."""

from sqlalchemy import select

from .chart_history_plan import lock_plan_instrument
from .storage import (
    Audit,
    ChartAlert,
    ChartAlertVersion,
    ChartHistoryPlan,
    ChartPublication,
    CompositeRevision,
    HistoryArtifact,
    HistoryVersion,
    Instrument,
    MarketComposite,
    MarketDataset,
    MarketDemand,
    Preference,
    RealtimeMapping,
    now_ms,
)


def preference_key(instrument_id):
    return "managed_realtime:" + instrument_id


def configured(db, instrument_id):
    value = db.scalar(select(Preference.value).where(Preference.key == preference_key(instrument_id)))
    return value["enabled"] if value else None


def enabled(db, instrument_id):
    instrument = db.get(Instrument, instrument_id)
    if not instrument:
        return False
    choice = configured(db, instrument_id)
    if choice is not None:
        return choice
    return compatibility_default(db, instrument_id, now=now_ms())


def compatibility_default(db, instrument_id, *, now):
    """Gate registered datasets on mapped consumers; retain unregistered legacy state."""
    datasets = set(db.scalars(select(MarketDataset.id).where(
        MarketDataset.instrument_id == instrument_id)))
    if not datasets:
        plan = db.scalar(select(ChartHistoryPlan.realtime_enabled).where(
            ChartHistoryPlan.instrument_id == instrument_id))
        if plan is not None:
            return bool(plan)
        return bool(db.scalar(select(Instrument.enabled).where(Instrument.id == instrument_id)))
    revisions = set(db.scalars(select(CompositeRevision.id).join(HistoryVersion,
        HistoryVersion.id == CompositeRevision.history_version_id).where(
            HistoryVersion.dataset_id.in_(datasets)).join(RealtimeMapping,
                RealtimeMapping.id == CompositeRevision.mapping_id)))
    if not revisions:
        return False
    heads = dict(db.execute(select(MarketComposite.instrument_id, MarketComposite.active_revision_id).where(
        MarketComposite.dataset_id.in_(datasets))).all())
    leases = db.scalars(select(MarketDemand).where(MarketDemand.expires > now))
    if any((lease.composite_revision_id or heads.get(lease.instrument_id)) in revisions for lease in leases):
        return True
    versions = db.scalars(select(ChartAlertVersion).join(ChartAlert, (
        ChartAlertVersion.alert_id == ChartAlert.id) & (ChartAlertVersion.version == ChartAlert.version)
    ).where(ChartAlert.status == "active", (ChartAlert.expires_at.is_(None) |
        (ChartAlert.expires_at > now))))
    if any(version.config.get("series_kind") == "composite"
        and version.market_identity.get("composite_revision_id") in revisions for version in versions):
        return True
    held_rules = db.scalars(select(ChartAlert).where(ChartAlert.status == "paused",
        ChartAlert.runtime["demand_hold"].as_string() == "stale_input",
        (ChartAlert.expires_at.is_(None) | (ChartAlert.expires_at > now))))
    for alert in held_rules:
        version = db.scalar(select(ChartAlertVersion).where(
            ChartAlertVersion.alert_id == alert.id, ChartAlertVersion.version == alert.version))
        if (version and version.config.get("series_kind") == "composite"
                and version.market_identity.get("composite_revision_id") in revisions):
            return True
    return False


def initialize_defaults(db, *, now):
    """Snapshot compatibility once; lease expiry must not change a saved choice.

    Called under bootstrap's PostgreSQL advisory lock before runtime assembly.
    New registered datasets default off. Legacy standalone instruments retain
    their persisted enabled flag until an explicit user choice replaces it.
    """
    instruments = list(db.scalars(select(MarketDataset.instrument_id).distinct().order_by(MarketDataset.instrument_id)))
    for instrument_id in instruments:
        lock_plan_instrument(db, instrument_id)
        value = configured(db, instrument_id)
        if value is None:
            value = compatibility_default(db, instrument_id, now=now)
            db.add(Preference(key=preference_key(instrument_id), value={"enabled": value, "updated_at": now}))
            plan = db.get(ChartHistoryPlan, instrument_id, populate_existing=True)
            if plan:
                plan.realtime_enabled = value
    db.flush()


def revision_instrument_id(db, revision):
    version = db.get(HistoryVersion, revision.history_version_id)
    dataset = db.get(MarketDataset, version.dataset_id) if version else None
    return dataset.instrument_id if dataset else None


def revision_enabled(db, revision):
    instrument_id = revision_instrument_id(db, revision)
    return bool(instrument_id and enabled(db, instrument_id))


def set_enabled(db, instrument_id, value, *, now):
    if type(value) is not bool:
        raise ValueError("实时开关必须是布尔值")
    instrument = lock_plan_instrument(db, instrument_id)
    if instrument.source not in ("dukascopy", "oanda", "binance", "fxcm"):
        raise ValueError("实时开关仅适用于自建行情")
    plan = db.get(ChartHistoryPlan, instrument_id, populate_existing=True)
    choice = db.get(Preference, preference_key(instrument_id), populate_existing=True)
    previous = enabled(db, instrument_id)
    if choice is None:
        choice = Preference(key=preference_key(instrument_id), value={"enabled": value, "updated_at": now})
        db.add(choice)
    elif choice.value["enabled"] != value:
        choice.value = {"enabled": value, "updated_at": now}
    is_registered_dataset = db.scalar(select(MarketDataset.id).where(
        MarketDataset.instrument_id == instrument_id).limit(1)) is not None
    if not is_registered_dataset:
        instrument.enabled = value
    if plan and plan.realtime_enabled != value:
        plan.realtime_enabled = value
        plan.updated_at = now
    if previous != value:
        db.add(Audit(kind="managed_realtime_changed", details={
            "instrument": instrument_id, "enabled": value,
            "history_status": plan.status if plan else "unmaintained"}))
    db.flush()
    return instrument, plan


def status(db, instrument_id, *, now):
    instrument = db.get(Instrument, instrument_id)
    if not instrument or instrument.source not in ("dukascopy", "oanda", "binance", "fxcm"):
        raise ValueError("自建行情不存在或不支持实时开关")
    plan = db.get(ChartHistoryPlan, instrument_id)
    dataset_ids = set(db.scalars(select(MarketDataset.id).where(
        MarketDataset.instrument_id == instrument_id)))
    from .composite_quotes import live_snapshot

    composites = []
    for composite in db.scalars(select(MarketComposite)):
        revision = db.get(CompositeRevision, composite.active_revision_id)
        version = db.get(HistoryVersion, revision.history_version_id) if revision else None
        if version and version.dataset_id in dataset_ids:
            live = live_snapshot(db, revision, now=now)
            eligible = enabled(db, instrument_id) and live["sample_ready"]
            composites.append({"id": composite.id, "revision_id": revision.id,
                "alert_eligible": eligible,
                "reason": None if eligible else "实时流关闭或实时来源尚未就绪"})
    fixed_artifact = db.scalar(select(HistoryArtifact.version_id).join(HistoryVersion,
        HistoryVersion.id == HistoryArtifact.version_id).where(
        HistoryVersion.dataset_id.in_(dataset_ids), HistoryVersion.status == "published",
        HistoryArtifact.status == "published", HistoryArtifact.count > 0).limit(1)) if dataset_ids else None
    history_available = bool(fixed_artifact or db.scalar(select(ChartPublication.instrument_id).where(
        ChartPublication.instrument_id == instrument_id, ChartPublication.initialized.is_(True),
        ChartPublication.complete_count > 0).limit(1)))
    return {
        "instrument": instrument_id,
        "realtime_enabled": enabled(db, instrument_id),
        "history_status": "available" if history_available else plan.status if plan else "unmaintained",
        "history_available": history_available,
        "composites": composites,
        "updated_at": (db.get(Preference, preference_key(instrument_id)).value["updated_at"]
                       if configured(db, instrument_id) is not None else plan.updated_at if plan else None),
        "read_at": now,
    }
