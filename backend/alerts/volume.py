"""Source semantics and exact Numeric(38,18) volume validation."""
from decimal import Decimal, InvalidOperation, localcontext


def quantity(value, *, tick=False):
    if value is None:
        return None
    try:
        amount = Decimal(str(value))
    except InvalidOperation as exc:
        raise ValueError('Invalid volume') from exc
    if not amount.is_finite() or amount < 0 or amount >= Decimal('1e20'):
        raise ValueError('Volume must be finite, nonnegative and fit Numeric(38,18)')
    with localcontext() as context:
        context.prec = 80
        if amount != amount.quantize(Decimal('1e-18')):
            raise ValueError('Volume exceeds 18 decimal places')
    if tick and amount != amount.to_integral_value():
        raise ValueError('OANDA volume must be an integer quote count')
    return amount


def encoded(value, *, tick=False):
    amount = quantity(value, tick=tick)
    return format(amount, 'f') if amount is not None else None


def total(members):
    if not members or any(m.volume is None for m in members):
        return None
    with localcontext() as context:
        context.prec = 80
        return quantity(sum((m.volume for m in members), Decimal(0)))


def metadata(source, symbol):
    if source == 'binance':
        # The current supported Spot catalog contains only BTCUSDT.
        return dict(volume_kind='base', volume_unit='BTC' if symbol == 'BTCUSDT' else 'base asset')
    if source == 'oanda':
        return dict(volume_kind='tick', volume_unit='quotes')
    if source == 'dukascopy':
        return dict(volume_kind='quantity', volume_unit='source_quantity')
    return dict(volume_kind='unavailable', volume_unit=None)
