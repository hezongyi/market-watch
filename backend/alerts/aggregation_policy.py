"""User-selected historical aggregation phases, separate from trading sessions."""

import hashlib
from typing import Literal

from sqlalchemy import select

from .market_contracts import DatasetIdentity
from .market_datasets import register_dataset
from .storage import Bar, HistoryVersion, Instrument, MarketDataset

AssetClass = Literal["forex", "metal", "crypto", "index", "other", "unspecified"]
AggregationCalendar = Literal["ny17", "utc0"]
ASSET_CLASSES = ("forex", "metal", "crypto", "index", "other", "unspecified")
DEFAULTS = {"forex": "ny17", "metal": "ny17", "crypto": "utc0"}


def resolve_calendar(asset_class, calendar=None):
    if asset_class not in ASSET_CLASSES:
        raise ValueError("不支持的资产类别")
    if calendar is not None:
        if calendar not in ("ny17", "utc0"):
            raise ValueError("聚合日界请选择NY17或UTC 00:00")
        return calendar
    if asset_class not in DEFAULTS:
        raise ValueError("该资产类别的聚合日界待定，请明确选择后再注册")
    return DEFAULTS[asset_class]


def register_history_dataset(db, *, logical_symbol, provider_symbol, asset_class, precision,
                             aggregation_calendar=None, source="dukascopy"):
    calendar = resolve_calendar(asset_class, aggregation_calendar)
    if source == "dukascopy":
        channel, environment, scope = "python", "historical", "public"
        volume_kind, volume_unit = "quantity", "source_quantity"
    elif source == "oanda":
        import re

        from .config import settings

        if not settings.oanda_account_id or not settings.oanda_token:
            raise ValueError("请先配置OANDA Practice连接")
        if not re.fullmatch(r"[A-Z0-9]+(?:_[A-Z0-9]+)+", provider_symbol):
            raise ValueError("请选择准确的OANDA品种代码")
        channel, environment = "v20", "practice"
        scope = "sha256:" + hashlib.sha256(settings.oanda_account_id.encode()).hexdigest()
        volume_kind, volume_unit = "price_count", "quotes"
    else:
        raise ValueError("此来源尚未支持自建历史版本")
    identity = DatasetIdentity(source=source, channel=channel, environment=environment,
        account_scope=scope, provider_symbol=provider_symbol, basis="bid",
        calendar_version=f"user-{asset_class}-{calendar}-v1")
    inst = register_dataset(db, identity, logical_symbol=logical_symbol, label=logical_symbol,
        calendar=calendar, precision=precision, volume_kind=volume_kind,
        volume_unit=volume_unit, asset_class=asset_class)
    return db.get(MarketDataset, identity.key), inst


def change_aggregation(db, dataset_id, calendar, *, version_id=None):
    """New identity/version; never mutate previously stored OHLC or pinned replays."""
    if calendar not in ("ny17", "utc0"):
        raise ValueError("聚合日界请选择NY17或UTC 00:00")
    source = db.get(MarketDataset, dataset_id)
    if not source:
        raise ValueError("数据集不存在")
    identity = DatasetIdentity.model_validate(source.identity)
    from .history_sources import history_identity

    history_identity(identity)
    inst = db.scalar(select(Instrument).where(Instrument.id == source.instrument_id).with_for_update())
    original = db.get(HistoryVersion, version_id) if version_id else None
    if version_id and (not original or original.dataset_id != source.id
                       or original.status != "published"):
        raise ValueError("请选择该数据集已发布的历史版本")
    if inst.calendar == calendar:
        return source, inst, original
    digest = hashlib.sha256((identity.calendar_version + "|" + calendar).encode()).hexdigest()[:24]
    target = identity.model_copy(update={"calendar_version": f"agg-{calendar}-{digest}"})
    profile = {**inst.calendar_profile, "revision": target.calendar_version} if inst.calendar_profile else None
    destination = register_dataset(db, target, logical_symbol=source.logical_symbol, label=inst.label,
        calendar=calendar, precision=inst.precision, volume_kind=source.volume_kind,
        volume_unit=source.volume_unit, calendar_profile=profile, asset_class=source.asset_class)
    version = None
    if original:
        # Same parent retry is idempotent, even after the worker has published it.
        version = next((row for row in db.scalars(select(HistoryVersion).where(
            HistoryVersion.dataset_id == target.key))
            if row.manifest.get("provenance", {}).get("derived_from_version") == original.id), None)
        if not version:
            if (db.scalar(select(Bar.id).where(Bar.instrument_id == destination.id).limit(1))
                    or db.scalar(select(HistoryVersion.id).where(
                        HistoryVersion.dataset_id == target.key).limit(1))):
                raise ValueError("目标日界数据集已有历史，请使用该数据集现有版本")
            from .history_derivation import derive_version

            ident = derive_version(db, original.id, target.key)
            version = db.get(HistoryVersion, ident)
    return db.get(MarketDataset, target.key), destination, version
