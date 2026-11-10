"""Read-only draft catalog and creation checks; no supplier I/O or registration."""

from types import SimpleNamespace

from .aggregation_policy import history_dataset_identity, resolve_calendar
from .config import settings
from .storage import DatasetMaintenance, Instrument, MarketDataset, now_ms


class CreationCheckError(ValueError):
    def __init__(self, message, field):
        super().__init__(message)
        self.field = field


def search_catalog(db, *, source="", query="", symbol_type="", offset=0, limit=50):
    from .fxcm_history import configured as fxcm_configured
    from .history_catalog import creation_entry
    from .instrument_directory import SOURCES, has_entries, search
    from .search_types import TYPES

    if source not in ("", *SOURCES) or symbol_type not in TYPES or offset < 0 or not 1 <= limit <= 100:
        raise ValueError("请选择支持自建历史的来源")
    asset = {"stock": "equity", "fund": "etf", "futures": "future", "commodity": "metal"}.get(symbol_type, symbol_type) or None
    result = search(db, source=source or None, query=query, asset=asset, managed=True,
                    offset=offset, limit=limit)
    sources = []
    for name in [source] if source else SOURCES:
        sources.append({"source": name,
            "requires_refresh": not has_entries(db, name),
            "connection_configured": fxcm_configured() if name == "fxcm" else name != "oanda"
                or bool(settings.oanda_account_id and settings.oanda_token)})
    return {**result, "items": [creation_entry(row) for row in result["items"]], "sources": sources}


def check_creation(db, body):
    from .data_center import dataset_detail
    from .history_api import CreationCheckRequest
    from .managed_dataset import date_start

    body = CreationCheckRequest.model_validate(body)
    if body.source == "oanda" and not (settings.oanda_account_id and settings.oanda_token):
        return {"status": "connection_required", "start": None, "existing": None}
    from .fxcm_history import configured as fxcm_configured
    if body.source == "fxcm" and not fxcm_configured():
        return {"status": "connection_required", "start": None, "existing": None}
    identity = history_dataset_identity(
        source=body.source,
        provider_symbol=body.provider_symbol,
        asset_class=body.asset_class,
        aggregation_calendar=body.aggregation_calendar,
        mode=body.mode, adjustment=body.adjustment,
    )
    if identity.identity_version == 2:
        from .history_mode_sources import local_details, validate_frames

        info, _ = local_details(db, body.source, body.provider_symbol)
        validate_frames(identity, info, body.timeframes)
    if body.catalog_id:
        from .history_catalog import creation_entry
        from .instrument_directory import selected

        row = selected(db, body.source, body.catalog_id)
        item = creation_entry(row) if row else None
        if not item or any(
            item[key] != getattr(body, key)
            for key in ("provider_symbol", "logical_symbol", "asset_class")
        ):
            raise ValueError("来源目录已变化，请重新选择品种")
        if item["precision"] is not None and body.precision != item["precision"]:
            raise CreationCheckError(
                "价格精度与当前来源目录不一致，请重新选择品种", "create-precision"
            )
    existing = db.get(MarketDataset, identity.key)
    if existing:
        inst = db.get(Instrument, existing.instrument_id)
        if (
            db.get(DatasetMaintenance, identity.key)
            or existing.logical_symbol != body.logical_symbol
            or body.precision is not None
            and inst.precision != body.precision
        ):
            return {
                "status": "existing",
                "start": None,
                "existing": dataset_detail(db, identity.key),
            }
    start = None
    if body.start_date:
        try:
            start = date_start(
                SimpleNamespace(
                    calendar="source_date" if identity.identity_version == 2 else resolve_calendar(body.asset_class, body.aggregation_calendar)
                ),
                body.start_date,
            )
        except ValueError:
            raise CreationCheckError("请选择有效的起始交易日期", "create-day") from None
        if not 0 <= start < (now_ms() - 5000) // 60000 * 60000:
            raise CreationCheckError("历史起点必须早于最新已完成分钟", "create-day")
    return {
        "status": "precision_required" if body.precision is None else "ready",
        "start": start,
        "existing": None,
    }
