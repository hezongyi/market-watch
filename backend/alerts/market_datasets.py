"""Explicit managed dataset registration. Legacy histories are never rebound."""

from decimal import ROUND_HALF_UP, Context, Decimal, InvalidOperation, localcontext

from sqlalchemy import func, select

from .calendar_profile import closures_from, normalized_profile, session_from
from .chart_series import display_symbol
from .market_contracts import CandleBatch, DatasetIdentity, MarketRequestError, RequestResult
from .storage import Bar, Instrument, MarketDataset

PRICE_RULE_VERSION = "dataset-precision-half-up-v1"
_STORAGE_LIMIT = Decimal("1e14")


class PricePrecisionError(ValueError):
    """Legacy imports require explicit rule activation before rounding."""


def price_rule(manifest):
    """Resolve a frozen version rule, rejecting incomplete/unknown policies."""
    manifest = manifest or {}
    if "price_rule_version" not in manifest and "price_precision" not in manifest:
        return None
    if manifest.get("price_rule_version") != PRICE_RULE_VERSION:
        raise ValueError("Unsupported historical price rule")
    precision = manifest.get("price_precision")
    if type(precision) is not int or not 0 <= precision <= 10:
        raise ValueError("Unsupported historical price precision")
    return PRICE_RULE_VERSION, precision


def version_price_rows(rows, manifest):
    rule = price_rule(manifest)
    return process_rows(rows, rule[1]) if rule else list(rows)


def process_price_row(row, precision, *, allow_rounding=True):
    """Validate and normalize one source row for the dataset's business view.

    Raw source strings are returned byte-for-byte when their effective scale is
    already within the registered precision.  Only excess scale is rounded,
    using a local Decimal context so no ambient context can alter the result.
    """
    if type(precision) is not int or not 0 <= precision <= 10:
        raise ValueError("Unsupported price precision")
    result = dict(row)
    prices, original = {}, {}
    for field in ("open", "high", "low", "close"):
        raw = row.get(field)
        if not isinstance(raw, str):
            raise ValueError("Price must be a decimal string")
        try:
            value = Decimal(raw)
        except (InvalidOperation, ValueError) as error:
            raise ValueError("Invalid Decimal price") from error
        if not value.is_finite() or value <= 0 or value >= _STORAGE_LIMIT:
            raise ValueError("Price must be positive and within storage range")
        original[field] = value
        digits = value.as_tuple().digits
        trailing = 0
        for digit in reversed(digits):
            if digit:
                break
            trailing += 1
        effective_scale = max(0, -value.as_tuple().exponent - trailing)
        if effective_scale <= precision:
            output = raw
        else:
            if not allow_rounding:
                raise PricePrecisionError("Price exceeds legacy dataset precision")
            quantum = Decimal((0, (1,), -precision))
            with localcontext(Context(prec=max(80, len(digits) + precision + 24))):
                output = str(value.quantize(quantum, rounding=ROUND_HALF_UP))
            rounded = Decimal(output)
            if not rounded.is_finite() or rounded <= 0 or rounded >= _STORAGE_LIMIT:
                raise ValueError("Rounded price is outside storage range")
        prices[field] = Decimal(output)
        result[field] = output
    for values in (original, prices):
        if (values["low"] > min(values["open"], values["close"])
                or values["high"] < max(values["open"], values["close"])):
            raise ValueError("Invalid OHLC extremes")
    return result


def process_rows(rows, precision):
    return [process_price_row(row, precision) for row in rows]


def register_dataset(db, identity, *, logical_symbol, label, calendar, precision,
                     volume_kind, volume_unit, calendar_profile=None, asset_class="unspecified"):
    if asset_class not in ("forex", "metal", "crypto", "index", "equity", "etf", "future", "other", "unspecified"):
        raise ValueError("Unsupported asset class")
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
    if calendar not in ("ny17", "utc0", "source_date"):
        raise ValueError("Unsupported aggregation calendar")
    if identity.identity_version == 2:
        rules = profile.get("trading_date")
        if (calendar != "source_date" or not rules
                or rules["rule"] != identity.trading_date_rule):
            raise ValueError("New history modes require explicit source trading-date rules")
    elif calendar == "source_date":
        raise ValueError("Legacy M1 datasets cannot use source trading-date calendars")
    if volume_kind not in ("quantity", "price_count", "tick_count", "base", "unavailable"):
        raise ValueError("Unsupported volume kind")
    if volume_unit is not None and not 0 < len(volume_unit) <= 40:
        raise ValueError("Invalid volume unit")
    # A short qualified ID remains usable by existing managed chart/replay routes.
    ident = "MD:" + identity.key[:25] + ":" + logical_symbol
    row = db.get(MarketDataset, identity.key)
    if row:
        inst = db.get(Instrument, row.instrument_id)
        if (row.asset_class != asset_class or row.logical_symbol != logical_symbol or inst.calendar != calendar or inst.calendar_profile != profile
                or inst.precision != precision
                or (row.volume_kind, row.volume_unit) != (volume_kind, volume_unit)):
            raise ValueError("Existing dataset metadata cannot be reinterpreted")
        assert_binding(inst, row, identity)
        from .source_registry import link_dataset

        link_dataset(db, row)
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
                         volume_unit=volume_unit, asset_class=asset_class))
    db.flush()
    from .source_registry import link_dataset

    link_dataset(db, db.get(MarketDataset, identity.key))
    return inst


def assert_binding(inst, row, identity):
    stored = DatasetIdentity.model_validate(row.identity)
    if (stored.key != row.id or stored != identity
            or (inst.source, inst.symbol, inst.basis)
            != (stored.source, stored.provider_symbol, stored.basis)):
        raise ValueError("数据集身份不匹配，拒绝重新解释或混合数据")


def validate_ingestion(db, inst, payload, *, price_manifest=None):
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
    raw_rows = [candle.model_dump() for candle in batch.rows]
    if price_manifest is None:
        rows = process_rows(raw_rows, inst.precision)
    elif price_rule(price_manifest) is None:
        rows = [process_price_row(row, inst.precision, allow_rounding=False) for row in raw_rows]
    else:
        rows = version_price_rows(raw_rows, price_manifest)
    from .market_contracts import MinuteRow

    return batch.model_copy(update={"rows": tuple(MinuteRow.model_validate(row) for row in rows)})


def legacy_inventory(db):
    """Read-only mapping audit; no account IDs, prices or credentials in output."""
    counts = dict(db.execute(select(Bar.instrument_id, func.count()).group_by(Bar.instrument_id)).all())
    bindings = {row.instrument_id: row for row in db.scalars(select(MarketDataset))}
    return [{"instrument": inst.id, "source": inst.source, "provider_symbol": inst.symbol,
             "basis": inst.basis, "calendar": inst.calendar, "bars": counts.get(inst.id, 0),
             "mapping": "explicit" if inst.id in bindings else "legacy_unverified"}
            for inst in db.scalars(select(Instrument).order_by(Instrument.id))]
