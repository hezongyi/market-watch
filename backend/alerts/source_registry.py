"""Canonical collection identity and real adapter capabilities for all three layers.

A collection ignores local aggregation phase. Legacy MD bindings retain their
original IDs; this module adds explicit links instead of reinterpreting them.
Capability reads do not register datasets, create demand or contact a provider.
"""

import hashlib
import json
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from .market_contracts import DatasetIdentity


class SourceIdentity(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")
    source: str = Field(min_length=1, max_length=32)
    channel: str = Field(min_length=1, max_length=64)
    environment: str = Field(min_length=1, max_length=32)
    account_scope: str = Field(pattern=r"^(public|sha256:[a-f0-9]{64})$", max_length=71)
    provider_symbol: str = Field(min_length=1, max_length=64)
    basis: str = Field(min_length=1, max_length=16)
    parameters: dict

    @property
    def key(self):
        return hashlib.sha256(json.dumps(self.model_dump(), sort_keys=True,
                                        separators=(",", ":")).encode()).hexdigest()


def collection_identity(identity):
    """Normalize only adapter parameters whose existing M1 semantics are known."""
    # Native provider paths already carry a complete SourceIdentity.  Keep all
    # OANDA request parameters in that identity instead of collapsing it to the
    # legacy M1/BID collection key.  This is also the bridge used by the REST
    # batch planner when a platform-native period is subscribed.
    raw = identity.model_dump() if hasattr(identity, "model_dump") else dict(identity)
    if "parameters" in raw:
        source = SourceIdentity.model_validate(raw)
        if (source.source, source.channel, source.environment) == ("oanda", "v20", "practice"):
            from .native_series import BASES, OandaParameters

            values = dict(source.parameters)
            granularity = values.pop("granularity", "M1")
            units = values.pop("units", "1")
            native = OandaParameters.model_validate(values).model_dump()
            return source.model_copy(update={
                "basis": BASES[native["price"]],
                "parameters": {"granularity": granularity, **native, "units": units},
            })
        return source
    old = DatasetIdentity.model_validate(identity)
    signature = (old.source, old.channel, old.environment, old.basis)
    if signature == ("dukascopy", "python", "historical", "bid"):
        parameters = {"granularity": "M1", "offer_side": "BID"}
    elif signature == ("oanda", "v20", "practice", "bid"):
        parameters = {"granularity": "M1", "price": "B", "smooth": False}
    elif signature == ("binance", "rest", "public", "last"):
        parameters = {"interval": "1m", "market": "spot"}
    else:
        raise ValueError("来源M1口径尚未验证，不能自动关联采集身份")
    fields = old.model_dump(exclude={"calendar_version"})
    return SourceIdentity(**fields, parameters=parameters)


def platform_identity(identity, *, timeframe, daily_alignment=17,
                      alignment_timezone="America/New_York", weekly_alignment="Sunday",
                      price="B", smooth=False):
    """Native-period identity includes all price parameters, not pagination."""
    source = collection_identity(identity)
    if source.source != "oanda":
        raise ValueError("该来源原生周期身份尚未接入")
    from .provider_chart import OANDA_FRAMES

    if timeframe not in OANDA_FRAMES:
        raise ValueError("来源不支持此原生周期")
    from .native_series import BASES, OandaParameters
    native = OandaParameters.model_validate({"price": price, "smooth": smooth,
        "dailyAlignment": daily_alignment, "alignmentTimezone": alignment_timezone,
        "weeklyAlignment": weekly_alignment}).model_dump()
    return SourceIdentity(**source.model_dump(exclude={"parameters", "basis"}), basis=BASES[price],
        parameters={"granularity": OANDA_FRAMES[timeframe], **native})


def capabilities(source: str):
    """Supported paths, separate from credentials, catalog or runtime readiness."""
    from .chart_data import FRAMES
    from .provider_capabilities import YAHOO_INTERVALS

    if source == "dukascopy":
        return {"source": source, "native_periods": list(FRAMES), "native_status": "supported",
                "history_m1": True, "confirmation_m1": True, "stream": False,
                "channel": "python", "environment": "historical", "bases": ["bid"],
                "native_confirmation": "not_supplied",
                "native_completion": "elapsed_native_interval",
                "history_range": "provider_observations; per-symbol range requires querying",
                "volume_kind": "quantity", "volume_unit": "source_quantity"}
    if source == "oanda":
        from .native_series import DEFAULTS
        return {"source": source, "native_periods": list(FRAMES), "native_status": "supported",
                "history_m1": True, "confirmation_m1": True, "stream": True,
                "channel": "v20", "environment": "practice", "bases": ["bid"],
                "native_bases": ["bid", "ask", "mid"], "native_parameters": dict(DEFAULTS),
                "history_range": "account/product dependent; per-symbol range requires querying",
                "volume_kind": "price_count", "volume_unit": "quotes"}
    if source == "binance":
        return {"source": source, "native_periods": list(FRAMES), "native_status": "supported",
                "history_m1": True, "confirmation_m1": True, "stream": False,
                "channel": "rest", "environment": "public", "bases": ["last"],
                "history_range": "spot listing dependent; adapter currently supports BTCUSDT",
                "volume_kind": "base", "volume_unit": "source_base"}
    if source == "yahoo":
        return {"source": source, "native_periods": list(YAHOO_INTERVALS),
                "native_status": "supported_when_enabled", "history_m1": False,
                "confirmation_m1": False, "stream": False, "bases": ["last"],
                "history_range": "interval-specific retention; native adapter only"}
    raise ValueError("未知来源")


def link_dataset(db, dataset, *, unsupported: Literal["reject", "retain"] = "retain"):
    """Atomic idempotent link. Unknown legacy channels keep their old meaning."""
    from .storage import DatasetSource, SourceSeries

    try:
        identity = collection_identity(dataset.identity)
    except ValueError:
        if unsupported == "reject":
            raise
        return None
    insert = _insert(db)
    db.execute(insert(SourceSeries).values(id=identity.key, identity=identity.model_dump())
               .on_conflict_do_nothing(index_elements=["id"]))
    series = db.get(SourceSeries, identity.key)
    if SourceIdentity.model_validate(series.identity) != identity:
        raise ValueError("来源采集身份冲突")
    db.execute(insert(DatasetSource).values(dataset_id=dataset.id, source_id=series.id)
               .on_conflict_do_nothing(index_elements=["dataset_id"]))
    link = db.get(DatasetSource, dataset.id)
    if link.source_id != series.id:
        raise ValueError("已有数据集不能重新绑定到其他采集身份")
    return series


def _insert(db):
    from sqlalchemy.dialects.postgresql import insert as postgres_insert
    from sqlalchemy.dialects.sqlite import insert as sqlite_insert

    return postgres_insert if db.get_bind().dialect.name == "postgresql" else sqlite_insert


def source_report(db, dataset_id):
    from .storage import DatasetSource, MarketDataset, SourceSeries

    dataset = db.get(MarketDataset, dataset_id)
    if not dataset:
        raise ValueError("数据集不存在")
    link = db.get(DatasetSource, dataset_id)
    if not link:
        return {"status": "unmapped_legacy", "source_id": None}
    series = db.get(SourceSeries, link.source_id)
    identity = SourceIdentity.model_validate(series.identity)
    linked = list(db.scalars(select(DatasetSource.dataset_id).where(
        DatasetSource.source_id == series.id).order_by(DatasetSource.dataset_id)))
    return {"status": "linked", "source_id": series.id, "identity": identity.model_dump(),
            "dataset_ids": linked, "capabilities": capabilities(identity.source)}
