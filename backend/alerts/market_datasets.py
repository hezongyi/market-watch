"""Explicit managed dataset registration. Legacy histories are never rebound."""

from decimal import Decimal

from sqlalchemy import func, select

from .calendar_profile import closures_from, normalized_profile, session_from
from .chart_series import display_symbol
from .market_contracts import CandleBatch, DatasetIdentity, MarketRequestError, RequestResult
from .storage import Bar, Instrument, MarketDataset


class PricePrecisionError(ValueError):
    """Valid source observations exceed immutable registered price precision."""


def register_dataset(db, identity, *, logical_symbol, label, calendar, precision,
                     volume_kind, volume_unit, calendar_profile=None):
    identity = DatasetIdentity.model_validate(identity)
    profile = normalized_profile(calendar_profile) if calendar_profile else {}
    if profile and profile["revision"] != identity.calendar_version:
        raise ValueError("Calendar profile revision must match the dataset calendar identity")
    session = session_from(profile)
    if profile.get("closures") and session is None:
        raise ValueError("Explicit closure profiles require source/account applicability evidence")
    if session and any(not session.reviewed_start <= closure.start < closure.end <= session.reviewed_end
                       for closure in closures_from(profile)):
        raise ValueError("Closures must remain inside the finite session review interval")
    if session and any(getattr(session, key) != getattr(identity, key) for key in (
            "source", "channel", "environment", "provider_symbol", "account_scope")):
        raise ValueError("Source session applicability does not match this dataset identity")
    if display_symbol(logical_symbol) != logical_symbol or not logical_symbol.isalnum():
        raise ValueError("Logical symbol must be a canonical display code")
    if len(logical_symbol) > 10 or not 0 <= precision <= 10:
        raise ValueError("Unsupported logical symbol or price precision")
    if calendar not in ("ny17", "utc0"):
        raise ValueError("Unsupported aggregation calendar")
    if volume_kind not in ("quantity", "price_count", "tick_count", "base", "unavailable"):
        raise ValueError("Unsupported volume kind")
    if volume_unit is not None and not 0 < len(volume_unit) <= 40:
        raise ValueError("Invalid volume unit")
    # A short qualified ID remains usable by existing managed chart/replay routes.
    ident = "MD:" + identity.key[:25] + ":" + logical_symbol
    row = db.get(MarketDataset, identity.key)
    if row:
        inst = db.get(Instrument, row.instrument_id)
        if (row.logical_symbol != logical_symbol or inst.calendar != calendar or inst.calendar_profile != profile
                or inst.precision != precision
                or (row.volume_kind, row.volume_unit) != (volume_kind, volume_unit)):
            raise ValueError("Existing dataset metadata cannot be reinterpreted")
        assert_binding(inst, row, identity)
        return inst
    if db.get(Instrument, ident):
        raise ValueError("Refusing to rebind an existing instrument")
    inst = Instrument(id=ident, label=label, source=identity.source,
                      symbol=identity.provider_symbol, basis=identity.basis,
                      calendar=calendar, precision=precision, enabled=False,
                      calendar_profile=profile)
    db.add(inst)
    db.flush()
    db.add(MarketDataset(id=identity.key, instrument_id=ident, logical_symbol=logical_symbol,
                         identity=identity.model_dump(), volume_kind=volume_kind,
                         volume_unit=volume_unit))
    db.flush()
    return inst


def assert_binding(inst, row, identity):
    stored = DatasetIdentity.model_validate(row.identity)
    if (stored.key != row.id or stored != identity
            or (inst.source, inst.symbol, inst.basis)
            != (stored.source, stored.provider_symbol, stored.basis)):
        raise ValueError("数据集身份不匹配，拒绝重新解释或混合数据")


def validate_ingestion(db, inst, payload):
    result = payload.get("request_result")
    if result is not None:
        result = RequestResult.model_validate(result)
        if not result.successful:
            raise MarketRequestError(result)
        if bool(payload["rows"]) != (result.status == "data"):
            raise ValueError("Request result contradicts returned rows")
    row = db.scalar(select(MarketDataset).where(MarketDataset.instrument_id == inst.id))
    if row is None:
        if payload.get("identity") is not None:
            raise ValueError("显式数据集身份不能写入未映射的旧品种")
        return None
    batch = CandleBatch.model_validate({key: payload.get(key) for key in (
        "identity", "window_start", "window_end", "observed_at", "rows",
        "volume_kind", "volume_unit")}
        | {"result": result})
    assert_binding(inst, row, batch.identity)
    if (batch.volume_kind, batch.volume_unit) != (row.volume_kind, row.volume_unit):
        raise ValueError("Volume semantics do not match the registered dataset")
    for candle in batch.rows:
        for field in ("open", "high", "low", "close"):
            value = Decimal(getattr(candle, field))
            if value != value.quantize(Decimal(1).scaleb(-inst.precision)):
                raise PricePrecisionError("Price exceeds dataset precision")
    return batch


def legacy_inventory(db):
    """Read-only mapping audit; no account IDs, prices or credentials in output."""
    counts = dict(db.execute(select(Bar.instrument_id, func.count()).group_by(Bar.instrument_id)).all())
    bindings = {row.instrument_id: row for row in db.scalars(select(MarketDataset))}
    return [{"instrument": inst.id, "source": inst.source, "provider_symbol": inst.symbol,
             "basis": inst.basis, "calendar": inst.calendar, "bars": counts.get(inst.id, 0),
             "mapping": "explicit" if inst.id in bindings else "legacy_unverified"}
            for inst in db.scalars(select(Instrument).order_by(Instrument.id))]
