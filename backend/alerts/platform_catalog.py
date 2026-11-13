"""Paged platform directory; provider I/O is exclusively a refresh operation."""

from .config import settings
from .instrument_directory import search
from .market_presentation import present
from .source_registry import capabilities


def _entry(row):
    from .akshare_native import native_metadata, variant

    info, source = row["metadata_json"], row["source"]
    direct = variant(row["id"]) if source == "akshare" else None
    if direct:
        info = {**info, **native_metadata(direct[0])}
    native = capabilities(source)
    if source == "fxcm":
        native = {**native, "native_periods": info.get("native_frames", ["M1", "H1", "D1"])}
    if source == "akshare" and not direct:
        from .provider_akshare import supported_frames

        native = {**native, "native_periods": supported_frames(row["symbol"],
            "sina-a" if info.get("source_family") == "eastmoney-a" else info.get("source_family"), "none")}
    tencent = row["id"].startswith("TENCENT:")
    if tencent:
        native = {**native, "native_periods": ["D1"], "supported_modes": []}
    if direct:
        native = {**native, "native_periods": info["frames"], "supported_modes": []}
    ident = "OANDA:" + row["symbol"] if row["id"].startswith("HC:") else row["id"]
    result = {**row, "id": ident, "label": row["label"],
        "logical_symbol": None if tencent or direct else row["logical_symbol"],
        "metadata_json": info,
        "quality_note": info.get("quality_note"),
        "history_precision": None if info.get("precision_status") == "manual_required" else row["precision"],
        "precision_status": info.get("precision_status", "source_catalog"),
        "available": row["available"] and (source != "yahoo" or settings.yahoo_enabled)
            and (source != "akshare" or settings.akshare_enabled),
        "updated_at": row["updated_at"] or None,
        "capabilities": native, "history_catalog_id": row.get("physical_id", row["id"]),
        "verified_frames": info.get("verified_frames", info.get("archive_verified_frames", {}))}
    family = "tencent-a" if tencent else "sina-a" if info.get("source_family") == "eastmoney-a" else info.get("source_family")
    if source == "akshare" and not direct and family == "sina-hk":
        from .provider_akshare import HK_QUALITY_NOTE

        result["quality_note"] = HK_QUALITY_NOTE
    adjustment = info.get("adjustment")
    if direct:
        adjustment = "none"
    elif source == "akshare" and family in ("sina-a", "sina-hk", "tencent-a"):
        adjustment = "qfq"
    elif source == "yahoo" and not adjustment:
        adjustment = "auto" if row["asset_class"] in ("equity", "etf") else "supplier"
    result = present({**result, "adjustment": adjustment,
        "basis": info.get("basis") or native.get("bases", ["last"])[0]}, identity={**info, "source": source, "source_family": family,
        "environment": "practice" if source == "oanda" else "demo" if source == "fxcm" else "public"})
    return {**result, "label": result["instrument_name"], "provider_name": result["source_display"]}


def entries(db, *, query="", source=None, asset=None):
    result = search(db, query=query, source=source, asset=asset, limit=1_000_000)
    return [_entry(row) for row in result["items"]]


def catalog(db, *, query="", source=None, page=1, page_size=25, asset=None):
    if page < 1 or not 1 <= page_size <= 100:
        raise ValueError("无效的目录分页")
    result = search(db, query=query, source=source or None, asset=asset,
                    offset=(page - 1) * page_size, limit=page_size)
    return {**result, "items": managed_matches(db, [_entry(row) for row in result["items"]]),
            "page": page, "page_size": page_size, "revision": directory_revision(db)}


def directory_revision(db):
    """A compact invalidation hint for cached directory rows, never candles."""
    import hashlib
    import json

    from sqlalchemy import func, select

    from .history_catalog import account_scope
    from .storage import DatasetMaintenance, MarketCatalog, Preference

    catalog = db.execute(select(func.count(), func.max(MarketCatalog.updated_at),
        func.sum(MarketCatalog.updated_at))).one()
    plans = db.execute(select(func.count(), func.max(DatasetMaintenance.updated_at),
        func.sum(DatasetMaintenance.updated_at))).one()
    edit = db.get(Preference, "directory-display-edit")
    facts = [[int(item) if item is not None else None for item in catalog],
        [int(item) if item is not None else None for item in plans], edit.value if edit else None, account_scope(),
        settings.yahoo_enabled, settings.akshare_enabled, settings.fxcm_enabled]
    return hashlib.sha256(json.dumps(facts, sort_keys=True).encode()).hexdigest()


def managed_matches(db, items):
    """Locate saved maintenance by the same complete identity used to create it."""
    from sqlalchemy import select

    from .aggregation_policy import history_dataset_identity
    from .storage import DatasetMaintenance, MarketDataset

    candidates = {}
    for item in items:
        keys = []
        if item["id"].startswith(("TENCENT:", "SINA-NATIVE:", "TENCENT-NATIVE:")):
            item["managed_datasets"] = []
            continue
        modern = item["source"] in ("akshare", "yahoo")
        for adjustment in (("none", "qfq", "hfq") if item["source"] == "akshare" else ("none", "supplier") if modern else ("none",)):
            for mode in ("base_d1", "native_periods") if modern else ("base_m1",):
                for calendar in ("source_date",) if modern else ("ny17", "utc0"):
                    try:
                        identity = history_dataset_identity(source=item["source"],
                            provider_symbol=item["provider_symbol"], asset_class=item["asset_class"],
                            aggregation_calendar=calendar, mode=mode, adjustment=adjustment)
                    except ValueError:
                        continue
                    keys.append(identity.key)
        candidates[item["id"]] = keys
    keys = {key for values in candidates.values() for key in values}
    matches = {row.id: {"id": row.id, "mode": row.identity.get("mode", "base_m1"), "calendar": row.identity.get("calendar_version", "")}
        for row in db.scalars(select(MarketDataset).join(DatasetMaintenance,
            DatasetMaintenance.dataset_id == MarketDataset.id).where(MarketDataset.id.in_(keys)))} if keys else {}
    for item in items:
        item["managed_datasets"] = [matches[key] for key in candidates.get(item["id"], []) if key in matches]
    return items
