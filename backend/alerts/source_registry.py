"""Canonical collection identity and real adapter capabilities for all three layers.

A collection ignores local aggregation phase. Legacy MD bindings retain their
original IDs; this module adds explicit links instead of reinterpreting them.
Capability reads do not register datasets, create demand or contact a provider.
"""

from typing import Literal

from sqlalchemy import select

from .market_contracts import DatasetIdentity, SourceIdentity


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
    elif signature == ("fxcm", "forexconnect", "demo", "bid"):
        parameters = {"granularity": "m1", "price": "BID", "candle_open": "PreviousClose"}
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
    if source == "fxcm":
        return {"source": source, "native_periods": list(FRAMES),
                "native_status": "supported_when_enabled", "history_m1": True,
                "confirmation_m1": True, "stream": False, "channel": "forexconnect",
                "environment": "demo", "bases": ["bid"], "native_confirmation": "not_supplied",
                "native_completion": "elapsed_native_interval",
                "history_range": "account/product dependent; no inception boundary verified",
                "volume_kind": "tick_count", "volume_unit": "price_changes"}
    if source == "binance":
        return {"source": source, "native_periods": list(FRAMES), "native_status": "supported",
                "history_m1": True, "confirmation_m1": True, "stream": False,
                "channel": "rest", "environment": "public", "bases": ["last"],
                "history_range": "spot listing dependent; adapter currently supports BTCUSDT",
                "volume_kind": "base", "volume_unit": "source_base"}
    if source == "yahoo":
        return {"source": source, "native_periods": list(YAHOO_INTERVALS),
                "supported_modes": ["base_d1", "native_periods"], "base_frames": ["D1"],
                "native_status": "supported_when_enabled", "history_m1": False,
                "confirmation_m1": False, "stream": False, "bases": ["last"],
                "history_range": "interval-specific retention; native adapter only"}
    if source == "akshare":
        return {"source": source, "native_periods": [], "native_status": "symbol_probe_required",
                "supported_modes": ["base_d1", "native_periods"], "base_frames": ["D1"],
                "history_m1": False, "confirmation_m1": False, "stream": False,
                "bases": ["last"], "history_range": "verified symbol/endpoint/adjustment intersection"}
    raise ValueError("未知来源")


def link_dataset(db, dataset, *, unsupported: Literal["reject", "retain"] = "retain"):
    """Atomic idempotent link. Unknown legacy channels keep their old meaning."""
    from .storage import DatasetSource, SourceSeries

    if DatasetIdentity.model_validate(dataset.identity).identity_version == 2:
        # A v2 dataset is linked explicitly per input period. Never synthesize
        # a legacy M1 binding to make old callers accept a new history mode.
        return None
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


def link_frame_source(db, dataset, frame, identity):
    from .market_contracts import HISTORY_FRAMES
    from .storage import DatasetFrameSource, SourceSeries

    parent = DatasetIdentity.model_validate(dataset.identity)
    identity = SourceIdentity.model_validate(identity)
    if (parent.identity_version != 2 or frame not in HISTORY_FRAMES
            or parent.mode == "base_d1" and frame != "D1"):
        raise ValueError("Dataset mode does not directly collect this period")
    expected = {key: getattr(parent, key) for key in (
        "source", "channel", "environment", "account_scope", "provider_symbol", "basis")}
    if any(getattr(identity, key) != value for key, value in expected.items()):
        raise ValueError("Native acquisition identity differs from dataset")
    parameters = identity.parameters
    if (parameters.get("timeframe") != frame or parameters.get("adjustment") != parent.adjustment
            or parameters.get("source_family") != parent.source_family
            or parameters.get("trading_date_rule") != parent.trading_date_rule
            or any(not parameters.get(key) for key in ("endpoint", "session", "timezone", "rules"))):
        raise ValueError("Native acquisition requires exact endpoint, frame and session rules")
    insert = _insert(db)
    db.execute(insert(SourceSeries).values(id=identity.key, identity=identity.model_dump())
               .on_conflict_do_nothing(index_elements=["id"]))
    series = db.get(SourceSeries, identity.key)
    if SourceIdentity.model_validate(series.identity) != identity:
        raise ValueError("来源采集身份冲突")
    db.execute(insert(DatasetFrameSource).values(dataset_id=dataset.id, timeframe=frame,
        source_id=series.id).on_conflict_do_nothing(index_elements=["dataset_id", "timeframe"]))
    link = db.get(DatasetFrameSource, (dataset.id, frame))
    if link.source_id != series.id:
        raise ValueError("已有周期不能重新绑定到其他采集身份")
    return series


def _insert(db):
    from sqlalchemy.dialects.postgresql import insert as postgres_insert
    from sqlalchemy.dialects.sqlite import insert as sqlite_insert

    return postgres_insert if db.get_bind().dialect.name == "postgresql" else sqlite_insert


def source_report(db, dataset_id):
    from .storage import DatasetFrameSource, DatasetSource, MarketDataset, SourceSeries

    dataset = db.get(MarketDataset, dataset_id)
    if not dataset:
        raise ValueError("数据集不存在")
    if dataset.identity.get("identity_version", 1) == 2:
        frames = [{"timeframe": link.timeframe, "source_id": link.source_id,
                   "identity": db.get(SourceSeries, link.source_id).identity}
                  for link in db.scalars(select(DatasetFrameSource).where(
                      DatasetFrameSource.dataset_id == dataset.id).order_by(DatasetFrameSource.timeframe))]
        return {"status": "linked_periods", "mode": dataset.identity["mode"], "frames": frames}
    link = db.get(DatasetSource, dataset_id)
    if not link:
        return {"status": "unmapped_legacy", "source_id": None}
    series = db.get(SourceSeries, link.source_id)
    identity = SourceIdentity.model_validate(series.identity)
    linked = list(db.scalars(select(DatasetSource.dataset_id).where(
        DatasetSource.source_id == series.id).order_by(DatasetSource.dataset_id)))
    return {"status": "linked", "source_id": series.id, "identity": identity.model_dump(),
            "dataset_ids": linked, "capabilities": capabilities(identity.source)}
