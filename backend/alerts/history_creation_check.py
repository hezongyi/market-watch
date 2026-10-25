"""Read-only draft catalog and creation checks; no supplier I/O or registration."""

from types import SimpleNamespace

from .aggregation_policy import history_dataset_identity, resolve_calendar
from .config import settings
from .history_catalog import catalog
from .storage import DatasetMaintenance, Instrument, MarketDataset, now_ms


class CreationCheckError(ValueError):
    def __init__(self, message, field):
        super().__init__(message)
        self.field = field


def search_catalog(db, *, source="", query="", symbol_type="", offset=0, limit=50):
    if source not in ("", "dukascopy", "oanda", "akshare", "fxcm", "yahoo") or offset < 0 or not 1 <= limit <= 100:
        raise ValueError("请选择支持自建历史的来源")
    from .fxcm_history import configured as fxcm_configured
    items, sources = [], []
    for name in [source] if source else ["dukascopy", "oanda", "akshare", "fxcm", "yahoo"]:
        page = 1
        while True:
            result = catalog(
                db, source=name, query=query, symbol_type=symbol_type, page=page, page_size=100
            )
            items.extend(result["items"])
            if page == 1:
                sources.append(
                    {
                        "source": name,
                        "requires_refresh": result["requires_refresh"],
                        "connection_configured": fxcm_configured() if name == "fxcm" else name != "oanda"
                        or bool(settings.oanda_account_id and settings.oanda_token),
                    }
                )
            if page * 100 >= result["total"]:
                break
            page += 1
    items.sort(
        key=lambda item: (
            item.get("display_symbol") or item["provider_symbol"],
            item["source"],
            item["catalog_id"],
        )
    )
    return {"items": items[offset : offset + limit], "total": len(items), "sources": sources}


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
        entries = catalog(db, source=body.source, query=body.provider_symbol, page_size=100)[
            "items"
        ]
        item = next((item for item in entries if item["catalog_id"] == body.catalog_id), None)
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
