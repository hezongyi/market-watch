"""Paged platform directory; provider I/O is exclusively a refresh operation."""

from .config import settings
from .instrument_directory import search
from .source_registry import capabilities


def _entry(row):
    info, source = row["metadata_json"], row["source"]
    native = capabilities(source)
    if source == "fxcm":
        native = {**native, "native_periods": info.get("native_frames", ["M1", "H1", "D1"])}
    if source == "akshare":
        from .provider_akshare import supported_frames

        native = {**native, "native_periods": supported_frames(row["symbol"],
            "sina-a" if info.get("source_family") == "eastmoney-a" else info.get("source_family"), "none")}
    tencent = row["id"].startswith("TENCENT:")
    if tencent:
        native = {**native, "native_periods": ["D1"], "supported_modes": []}
    ident = "OANDA:" + row["symbol"] if row["id"].startswith("HC:") else row["id"]
    return {**row, "id": ident, "label": row["label"] + (" · 腾讯" if tencent else ""),
        **({"provider_name": "腾讯 (AKShare)" if tencent else "新浪 (AKShare)"}
           if source == "akshare" and info.get("source_family") in (
               "sina-a", "sina-hk", "sina-futures", "eastmoney-a") else {}),
        "logical_symbol": None if tencent else row["logical_symbol"],
        "history_precision": None if info.get("precision_status") == "manual_required" else row["precision"],
        "precision_status": info.get("precision_status", "source_catalog"),
        "available": row["available"] and (source != "yahoo" or settings.yahoo_enabled)
            and (source != "akshare" or settings.akshare_enabled),
        "updated_at": row["updated_at"] or None,
        "capabilities": native, "history_catalog_id": row.get("physical_id", row["id"]),
        "verified_frames": info.get("verified_frames", info.get("archive_verified_frames", {}))}


def entries(db, *, query="", source=None, asset=None):
    result = search(db, query=query, source=source, asset=asset, limit=1_000_000)
    return [_entry(row) for row in result["items"]]


def catalog(db, *, query="", source=None, page=1, page_size=25, asset=None):
    if page < 1 or not 1 <= page_size <= 100:
        raise ValueError("无效的目录分页")
    result = search(db, query=query, source=source or None, asset=asset,
                    offset=(page - 1) * page_size, limit=page_size)
    return {**result, "items": managed_matches(db, [_entry(row) for row in result["items"]]),
            "page": page, "page_size": page_size}


def managed_matches(db, items):
    """Locate saved maintenance by the same complete identity used to create it."""
    from sqlalchemy import select

    from .aggregation_policy import history_dataset_identity
    from .storage import DatasetMaintenance, MarketDataset

    candidates = {}
    for item in items:
        keys = []
        if item["id"].startswith("TENCENT:"):
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
