"""Shared native OANDA bar representation, including legacy completed payloads."""

from .native_series import chart_label, interval_end
from .oanda_rest_batch import decimal_text
from .volume import encoded


def _price_text(value):
    try:
        return decimal_text(value)
    except (TypeError, ValueError):
        # The foreground writer historically retained supplier text verbatim.
        # Keep that boundary compatible; canonical_payload only equates values
        # that the exact Decimal contract can prove equivalent.
        return str(value)


def canonical_payload(payload):
    """Only completed OANDA bars prove absent confirmation flags equivalent to true.

    Preserve explicit false, forming defaults and every other payload field. In
    particular, this is not a price-only signature: volume and labels still fence
    the indicator prefix. Return a copy; persisted/frozen observations are immutable.
    """
    result = dict(payload)
    # The REST model already uses exact canonical Decimal strings; foreground
    # history and persisted legacy bars may retain supplier trailing zeros.
    # Reuse its bounded price contract, preserving unproven legacy values.
    for field in ('open', 'high', 'low', 'close'):
        try:
            result[field] = _price_text(result[field])
        except (KeyError, ValueError):
            pass
    if result.get("complete") is True:
        result.setdefault("source_confirmed", True)
        result.setdefault("coverage_complete", True)
    return result


def native_bar(*, start, frame, parameters, complete, volume, open, high, low, close):
    """Both native writers use source completion, native labels and tick volume."""
    volume = encoded(volume, tick=True)
    return {
        "start": start,
        "end": interval_end(start, frame, parameters),
        "chart_time": chart_label(start, frame, parameters),
        "open": _price_text(open), "high": _price_text(high),
        "low": _price_text(low), "close": _price_text(close),
        "volume": volume,
        "volume_complete": bool(complete and volume is not None),
        "complete": complete,
        "source_confirmed": complete,
        "coverage_complete": complete,
    }
