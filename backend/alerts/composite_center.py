"""Pure composite management, mapping candidates and separate readiness facts."""

from sqlalchemy import func, or_, select

from .composite_definitions import baseline, latest_note
from .history_catalog import account_scope
from .market_names import code_search, display_code
from .market_usage import wanted_instruments
from .storage import (
    ChartAlert,
    ChartAlertVersion,
    CompositePreparation,
    CompositeReadAttempt,
    CompositeRevision,
    HistoryVersion,
    Instrument,
    LiveState,
    MarketComposite,
    MarketDataset,
    MarketDemand,
    RealtimeMapping,
    Watch,
    now_ms,
)

SCOPE = "workspace:default"


def mapping_report(db, row):
    target = db.get(MarketDataset, row.target_dataset_id)
    identity = target.identity
    note = latest_note(db, row.id)
    from .composite_matching import PRODUCT_FIELDS, check_match, live_identity

    valid = False
    try:
        from .history_catalog import catalog
        entries = catalog(db, source="oanda", query=identity["provider_symbol"], page_size=100)["items"]
        entry = next((item for item in entries if item["provider_symbol"] == identity["provider_symbol"]), None)
        if entry and target.id == live_identity(entry["provider_symbol"]).key:
            check = check_match(db, row.dataset_id, entry["catalog_id"])
            valid = check["status"] == "ready" and all(
                row.match.get(field) == check["suggestion"][field] for field in PRODUCT_FIELDS) and (
                row.match.get("target_catalog", {}).get("precision") == check["snapshot"]["precision"] and
                row.match.get("target_catalog", {}).get("type") == check["snapshot"]["asset_type"])
    except ValueError:
        pass
    return {"id": row.id, "dataset_id": row.dataset_id, "created_at": row.created_at,
        "target_dataset_id": target.id, "target_identity": identity, "match": row.match,
        "note": {"version": note.version, **note.content} if note else None,
        "valid_for_selection": valid,
        "target_display_symbol": display_code(identity["provider_symbol"], identity["source"], target.asset_class),
        "current_account": identity["account_scope"] == account_scope()}


def mappings(db, dataset_id, *, permission_scope=SCOPE):
    if not db.get(MarketDataset, dataset_id):
        raise ValueError("自建数据集不存在")
    return {"dataset_id": dataset_id, "items": [mapping_report(db, row) for row in db.scalars(
        select(RealtimeMapping).where(RealtimeMapping.dataset_id == dataset_id,
            RealtimeMapping.permission_scope == permission_scope).order_by(RealtimeMapping.created_at.desc(), RealtimeMapping.id))]}


def detail(db, composite_id, *, permission_scope=SCOPE):
    composite = db.get(MarketComposite, composite_id)
    if not composite or composite.permission_scope != permission_scope:
        raise ValueError("组合行情不存在或不属于当前权限范围")
    inst = db.get(Instrument, composite.instrument_id)
    revision = db.get(CompositeRevision, composite.active_revision_id)
    history = db.get(HistoryVersion, revision.history_version_id)
    dataset = db.get(MarketDataset, history.dataset_id)
    prep = db.get(CompositePreparation, revision.id)
    mapping = db.get(RealtimeMapping, revision.mapping_id)
    state = db.get(LiveState, mapping.target_dataset_id)
    wanted = wanted_instruments(db)
    stamp = now_ms()
    chart_count = db.scalar(select(func.count()).select_from(MarketDemand).where(
        MarketDemand.instrument_id == composite.instrument_id, MarketDemand.expires > stamp))
    watch_count = db.scalar(select(func.count()).select_from(Watch).where(
        Watch.instrument_id == composite.instrument_id, Watch.status == "active"))
    from .composite_watches import affected

    active_watches = affected(db, composite.id)
    active_alerts = [row for row in db.execute(
        select(ChartAlertVersion, ChartAlert).join(ChartAlert, (ChartAlertVersion.alert_id == ChartAlert.id) & (
            ChartAlertVersion.version == ChartAlert.version)).where(ChartAlert.status == "active",
                or_(ChartAlert.expires_at.is_(None), ChartAlert.expires_at > stamp)))
        if row[0].market_identity.get("composite_id") == composite.id]
    alert_count = sum(row.config.get("instrument") in (composite.instrument_id, composite.id) for row in db.scalars(
        select(ChartAlertVersion).join(ChartAlert, (ChartAlertVersion.alert_id == ChartAlert.id) & (
            ChartAlertVersion.version == ChartAlert.version)).where(ChartAlert.status == "active",
                or_(ChartAlert.expires_at.is_(None), ChartAlert.expires_at > stamp))))
    from .composite_quotes import live_snapshot

    live = live_snapshot(db, revision, now=stamp)
    current_account = live["current_account"]
    active = composite.instrument_id in wanted
    connection = live["connection"]
    quote_age = live["quote_age_ms"]
    quote_ready = live["quote_ready"]
    candle_ready = live.get("candle_ready", False)
    sample_ready = live.get("sample_ready", quote_ready)
    confirmed_ready = live["confirmed_tail_ready"]
    from .composite_aggregates import report
    status = "account_changed" if not current_account else "attention" if prep.error else (
        "preparing" if prep.status != "queried" else "inactive" if not active else
        'provider_maintenance' if live['connection_error'] == 'provider_maintenance' else
        'unauthorized' if live['authentication_hold'] else
        'market_closed' if live['market_session'] == 'closed' else
        "receiving" if confirmed_ready else "recovering")
    return {"id": composite.id, "instrument_id": composite.instrument_id,
        "dataset_id": dataset.id, "logical_symbol": dataset.logical_symbol,
        "display_symbol": display_code(dataset.logical_symbol, asset_type=dataset.asset_class),
        "precision": inst.precision, "calendar": revision.rules["aggregation_calendar"],
        "historical_source": dataset.identity["source"], "live_source": "oanda",
        "basis": inst.basis, "status": status, "created_at": composite.created_at,
        "periods": report(db, revision.id, prep.input_revision),
        "mapping": mapping_report(db, mapping), "active_revision_id": revision.id,
        "revision": {"id": revision.id, "history_version_id": history.id, "history_start": history.start,
            "history_end": history.end, "history_checksum": history.manifest["checksum"],
            "seam": revision.seam, "rules": revision.rules, "activated_at": revision.activated_at},
        "preparation": {"status": prep.status, "cursor": prep.cursor, "cutoff": prep.cutoff,
            "confirmed_end": prep.confirmed_end, "input_revision": prep.input_revision,
            "error": prep.error, "next_at": prep.next_at, "state": prep.state},
        "usage": {"charts": chart_count, "strategies": watch_count, "chart_alerts": alert_count,
                  "total": chart_count + watch_count + alert_count},
        "health": {"connection": connection, "quote_ready": quote_ready,
            "candle_ready": candle_ready, "sample_ready": sample_ready,
            "observation_mode": live.get("observation_mode", "stream_quote"),
            **{key: live[key] for key in ('market_session', 'next_session_at', 'calendar_verified',
                'authentication_hold', 'connection_error', 'next_probe_at')},
            "confirmed_tail_ready": confirmed_ready, "quote_age_ms": quote_age,
            "source_confirmed_end": state.confirmed_end if state else 0,
            "strategy_readiness": "no_strategies" if watch_count + alert_count == 0 else
                "ready" if len(active_watches) == watch_count and
                    all(row.health == "ready" for _, row in active_alerts) and
                    all(binding.health == "ready" for binding, _ in active_watches) else "pending_dependency_validation",
            "rules": [{"id": row.id, "name": row.name, "health": row.health, "reason": row.health_reason,
                "revision_id": version.market_identity["composite_revision_id"],
                "seam_policy": version.market_identity["seam_policy"], "readiness": row.runtime.get("readiness", {})}
                for version, row in active_alerts] + [{"id": watch.id, "name": watch.name,
                    "health": binding.health, "reason": binding.health_reason,
                    "revision_id": binding.revision_id, "seam_policy": binding.market_identity["seam_policy"],
                    "readiness": binding.runtime.get("readiness", {})} for binding, watch in active_watches],
            "coverage": "per-bar; query completion and newest M1 are not complete indicator dependencies"}}


def list_composites(db, *, query="", page=1, page_size=25, permission_scope=SCOPE, dataset_id=None):
    if page < 1 or not 1 <= page_size <= 100:
        raise ValueError("无效组合列表分页")
    base = select(MarketComposite.id).join(MarketDataset).where(MarketComposite.permission_scope == permission_scope)
    if dataset_id:
        base = base.where(MarketComposite.dataset_id == dataset_id)
    if query:
        base = base.where(code_search(query, MarketDataset.logical_symbol))
    total = db.scalar(select(func.count()).select_from(base.subquery()))
    rows = db.scalars(base.order_by(MarketDataset.logical_symbol, MarketComposite.id)
                      .offset((page - 1) * page_size).limit(page_size))
    return {"items": [detail(db, ident, permission_scope=permission_scope) for ident in rows],
            "total": total, "page": page, "page_size": page_size}


def candidates(db, *, query="", page=1, page_size=25, permission_scope=SCOPE, source=None, calendar=None):
    from .data_center import dataset_list

    result = dataset_list(db, query=query, page=page, page_size=page_size, source=source, calendar=calendar)
    output = []
    for dataset in result["items"]:
        reason = None
        try:
            baseline(db, dataset["id"], dataset["aggregation_calendar"])
        except ValueError as error:
            reason = str(error)
        matches = mappings(db, dataset["id"], permission_scope=permission_scope)["items"]
        valid = [item for item in matches if item["current_account"] and item["valid_for_selection"]]
        output.append({"dataset": dataset, "mappings": matches,
            "status": "needs_maintenance" if reason else "needs_mapping" if not valid else "ready_to_open",
            "reason": reason,
            "recommended_mapping_id": valid[0]["id"] if len(valid) == 1 else None})
    return {**result, "items": output}


def read_attempts(db, composite_id, *, page=1, page_size=25, permission_scope=SCOPE):
    row = detail(db, composite_id, permission_scope=permission_scope)
    if page < 1 or not 1 <= page_size <= 100:
        raise ValueError("无效补数请求分页")
    query = select(CompositeReadAttempt).where(CompositeReadAttempt.revision_id == row["active_revision_id"])
    total = db.scalar(select(func.count()).select_from(query.subquery()))
    fields = ("id", "start", "end", "started_at", "finished_at", "result", "read_kind",
              "checkpoint", "observed_at", "observations", "accepted")
    rows = db.scalars(query.order_by(CompositeReadAttempt.started_at.desc(), CompositeReadAttempt.id)
                     .offset((page - 1) * page_size).limit(page_size))
    return {"composite_id": composite_id, "revision_id": row["active_revision_id"],
            "items": [{key: getattr(item, key) for key in fields} for item in rows],
            "total": total, "page": page, "page_size": page_size}
