"""Read selected continuation health in batches, without per-row detail queries."""

from sqlalchemy import func, select

from .composite_center import SCOPE, runtime_status
from .composite_definitions import definition
from .composite_matching import saved_mapping_valid
from .composite_quotes import snapshot_values
from .config import settings
from .history_catalog import account_scope
from .live_pricing import account_key
from .managed_continuation import default_key
from .storage import (
    CompositePreparation,
    CompositeRevision,
    HistoryArtifact,
    HistoryArtifactBlock,
    HistoryReclamation,
    HistoryVersion,
    Instrument,
    LiveState,
    MarketCatalog,
    MarketComposite,
    MarketDataset,
    Preference,
    PricingOwner,
    RealtimeMapping,
    now_ms,
)


def summaries(db, datasets, switches):
    ids = [item.id for item in datasets]
    mapped = list(db.execute(select(RealtimeMapping, MarketDataset, Instrument).join(
        MarketDataset, MarketDataset.id == RealtimeMapping.target_dataset_id).join(
        Instrument, Instrument.id == MarketDataset.instrument_id).where(
        RealtimeMapping.dataset_id.in_(ids), RealtimeMapping.permission_scope == SCOPE)))
    result = {item.id: {"enabled": switches.get("managed_realtime:" + item.instrument_id, {}).get("enabled", False),
        "configured": False, "status": "disabled", "can_enable": False,
        "can_disable": bool(switches.get("managed_realtime:" + item.instrument_id, {}).get("enabled", False)),
        "disabled_reason": "待配置", "default_mapping_id": None} for item in datasets}
    for item in datasets:
        if item.identity.get("mode", "base_m1") != "base_m1" or item.identity.get("basis") != "bid":
            result[item.id]["disabled_reason"] = "不支持"
        elif not settings.oanda_account_id or not settings.oanda_token:
            result[item.id]["disabled_reason"] = "待配置"
    if not mapped:
        for row in result.values():
            row["status"] = "attention" if row["enabled"] else "disabled"
        return result
    # Keep references to all selected ORM objects for the lifetime of this read;
    # check_match/definition can reuse identity-map lookups without extra SQL.
    configuration_rows = list(db.execute(
        select(MarketComposite, CompositeRevision, CompositePreparation, MarketDataset, Instrument)
            .outerjoin(CompositeRevision, CompositeRevision.id == MarketComposite.active_revision_id)
            .outerjoin(CompositePreparation, CompositePreparation.revision_id == CompositeRevision.id)
            .outerjoin(HistoryVersion, HistoryVersion.id == CompositeRevision.history_version_id)
            .outerjoin(MarketDataset, MarketDataset.id == HistoryVersion.dataset_id)
            .outerjoin(Instrument, Instrument.id == MarketDataset.instrument_id).where(
                MarketComposite.dataset_id.in_(ids), MarketComposite.permission_scope == SCOPE)))
    for composite, *_ in configuration_rows:
        result[composite.dataset_id].setdefault("composite_ids", []).append(composite.id)
    configurations = {composite.id: (composite, revision, prep, source, source_inst)
        for composite, revision, prep, source, source_inst in configuration_rows
        if revision is not None and prep is not None and source is not None and source_inst is not None}
    original_mapping_ids = {mapping.id for mapping, _, _ in mapped}
    missing = {revision.mapping_id for _, revision, *_ in configurations.values()} - original_mapping_ids
    if missing:
        mapped.extend(db.execute(select(RealtimeMapping, MarketDataset, Instrument).join(
            MarketDataset, MarketDataset.id == RealtimeMapping.target_dataset_id).join(
            Instrument, Instrument.id == MarketDataset.instrument_id).where(RealtimeMapping.id.in_(missing))))
    targets = {target.id: (target, inst) for _, target, inst in mapped}
    entries = list(db.scalars(select(MarketCatalog).where(MarketCatalog.source == "oanda",
        MarketCatalog.symbol.in_([target.identity["provider_symbol"] for target, _ in targets.values()]),
        MarketCatalog.available.is_(True))))
    catalogs = {entry.symbol: entry for entry in entries
                if entry.metadata_json.get("history_account_scope") == account_scope()}
    states = {state.dataset_id: state for state in db.scalars(select(LiveState).where(LiveState.dataset_id.in_(targets)))}
    owner = db.get(PricingOwner, account_key(settings.oanda_account_id))
    keys = [default_key(ident) for ident in ids]
    keys += ["managed_rollover:" + ident for ident in configurations]
    keys += ["managed_realtime:" + source_inst.id for *_, source_inst in configurations.values()]
    keys += [prefix + ident for prefix in ("live_confirmation:v1:", "live_sampling:v1:") for ident in targets]
    if owner:
        keys.append("oanda_probe_status:" + owner.id)
    preferences = {row.key: row.value for row in db.scalars(select(Preference).where(Preference.key.in_(keys)))}
    valid = {ident: [] for ident in ids}
    for mapping, target, _ in mapped:
        if mapping.dataset_id not in result:
            continue
        result[mapping.dataset_id]["configured"] = True
        entry = catalogs.get(target.identity["provider_symbol"])
        if saved_mapping_valid(db, mapping, target, entry):
            valid[mapping.dataset_id].append(mapping)
    stamp = now_ms()
    # One bounded metadata query for the page, never a full continuation report
    # or a history payload read per list row. Writes retain first_use validation.
    rank = select(HistoryVersion.id, func.row_number().over(partition_by=HistoryVersion.dataset_id,
        order_by=(HistoryVersion.published_at.desc(), HistoryVersion.id.desc())).label("position")).join(
        HistoryArtifact).where(HistoryVersion.dataset_id.in_(ids), HistoryVersion.status == "published",
        HistoryArtifact.timeframe == "M1", HistoryArtifact.status == "published", HistoryArtifact.count > 0,
        ~select(HistoryReclamation.version_id).where(HistoryReclamation.version_id == HistoryVersion.id).exists()).subquery()
    baselines = {version.dataset_id: (version, end, artifact) for version, artifact, end in db.execute(
        select(HistoryVersion, HistoryArtifact, func.max(HistoryArtifactBlock.end)).join(rank, rank.c.id == HistoryVersion.id)
        .join(HistoryArtifact).join(HistoryArtifactBlock).where(rank.c.position == 1, HistoryArtifact.timeframe == "M1")
        .group_by(HistoryVersion.id, HistoryArtifact.id))}
    for dataset in datasets:
        row = result[dataset.id]
        choices = valid[dataset.id]
        saved = preferences.get(default_key(dataset.id))
        selected = saved.get("mapping_id") if saved else choices[0].id if len(choices) == 1 else None
        mapping = next((item for item in choices if item.id == selected), None)
        row["default_mapping_id"] = mapping.id if mapping else None
        row["status"] = "attention" if row["enabled"] else "disabled"
        if mapping is None:
            if row["disabled_reason"] != "不支持":
                row["disabled_reason"] = "账户变更" if row["configured"] else "待配置"
            continue
        *_, ident = definition(db, dataset.id, mapping.id)
        current = configurations.get(ident)
        supported = (dataset.identity.get("mode", "base_m1") == "base_m1" and dataset.identity.get("basis") == "bid"
            and bool(settings.oanda_account_id and settings.oanda_token))
        ready = current is not None
        if not ready and dataset.id in baselines:
            from .domain import session_bounds
            from .storage import instant, ms
            version, end, artifact = baselines[dataset.id]
            source = db.get(Instrument, dataset.instrument_id)
            manifest = artifact.manifest
            ready = (manifest.get("parent_version_id") == version.id
                and manifest.get("parent_checksum") == version.manifest.get("checksum")
                and manifest.get("timeframe") == "M1" and manifest.get("rule_version") == artifact.rule_version
                and ms(session_bounds(instant(min(end, version.end)), source.calendar)[0]) > version.start)
        row["can_enable"] = supported and ready
        row["disabled_reason"] = None if row["can_enable"] else "待历史" if supported else row["disabled_reason"]
        if not row["enabled"]:
            continue
        if current is None:
            row["status"] = "preparing"
            continue
        _, revision, prep, _, source_inst = current
        row["baseline_seam"] = revision.seam
        from .managed_rollover import window_warning

        row["rollover"] = window_warning(preferences.get("managed_rollover:" + ident, {"status": "idle"}),
                                         revision.seam, now=stamp)
        active = preferences.get("managed_realtime:" + source_inst.id, {}).get("enabled", False)
        # Baseline activation can move the active revision to another mapping.
        # Read that revision's exact target rather than the originally saved one.
        active_mapping = next((item for item, _, _ in mapped if item.id == revision.mapping_id), None)
        if active_mapping is None:
            continue
        target, instrument = targets[active_mapping.target_dataset_id]
        state = states.get(target.id)
        confirmation = preferences.get("live_confirmation:v1:" + target.id, {})
        sampling = preferences.get("live_sampling:v1:" + target.id, {})
        live = snapshot_values(target, instrument, state, owner, stamp=stamp, realtime_enabled=active,
            confirmation=confirmation if state and confirmation.get("epoch") == state.epoch else {},
            sampling=sampling.get("evidence", {}) if state and sampling.get("epoch") == state.epoch else {},
            probe=preferences.get("oanda_probe_status:" + owner.id, {}) if owner else {})
        row["status"] = runtime_status(prep, live, active=active)
    return result
