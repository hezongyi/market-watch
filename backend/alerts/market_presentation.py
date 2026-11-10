"""One read-only vocabulary for provider, managed, fixed and composite displays.

Names never participate in acquisition identities, account scopes or prices.
"""
from .market_names import chinese_name, display_code

KIND_NAMES = {'provider': '平台', 'managed': '自建',
              'history': '自建', 'composite': '组合'}


def source_name(source, *, family=None, environment=None):
    if source == 'akshare':
        upstream = ('新浪' if (family or '').startswith('sina-') else
                    '腾讯' if family == 'tencent-a' else '东方财富' if family == 'eastmoney-a' else '')
        return upstream + '（AKShare）' if upstream else 'AKShare'
    if source == 'oanda':
        return {'practice': 'OANDA Practice', 'live': 'OANDA Live'}.get(environment, 'OANDA')
    if source == 'fxcm':
        return {'demo': 'FXCM Demo', 'real': 'FXCM Real'}.get(environment, 'FXCM')
    return {'dukascopy': 'Dukascopy', 'binance': 'Binance Spot', 'yahoo': 'Yahoo Finance'}.get(source, source or '来源未知')


def _source(identity):
    return source_name(identity.get('source'), family=identity.get('source_family'),
                       environment=identity.get('environment'))


def present(meta, *, identity=None, realtime_identity=None):
    saved = identity or meta.get('source_identity') or meta
    kind = meta.get('series_kind', 'provider')
    source = saved.get('source') or meta.get('source')
    symbol = saved.get('provider_symbol') or meta.get('provider_symbol') or meta.get('symbol', '')
    shown = display_code(symbol if source == 'akshare' else (meta.get('display_symbol') or meta.get('symbol') or symbol),
                         source, meta.get('asset_type'))
    name = meta.get('name_zh') or (meta.get('name') if kind != 'provider' else None) or chinese_name(source, symbol) or meta.get('name') or meta.get('label') or shown
    family = saved.get('source_family') or meta.get('source_family')
    # Remove only the old generated seed suffix; explicit user names stay intact.
    if kind == 'provider' and family == 'sina-futures' and not meta.get('name_zh'):
        name = name.removesuffix(f'（新浪 {symbol.split(":")[-1]}）')
    # Continuous is an upstream series, not a deliverable monthly contract.
    if family == 'sina-futures' and symbol.endswith('0') and name.endswith('连续') and not name.endswith('主力连续'):
        name = name[:-2] + '主力连续'
    origin = {**saved, 'source': source, 'source_family': family}
    source_display = _source(origin)
    extra = {}
    if kind == 'composite':
        historical = _source(origin)
        live = _source(realtime_identity or {})
        source_display = f'历史：{historical} → 实时：{live}'
        extra = {'historical_source_display': historical, 'live_source_display': live}
    adjustment = meta.get('adjustment_view', meta.get('adjustment', saved.get('adjustment')))
    price = {'qfq': '前复权', 'hfq': '后复权', 'auto': '来源复权', 'supplier': '来源价格'}.get(adjustment)
    if not price:
        basis = meta.get('basis') or saved.get('basis')
        price = {'bid': '买价', 'ask': '卖价', 'mid': '中间价', 'adjusted': '来源复权'}.get(basis)
        if not price:
            price = '成交价' if source == 'binance' else '原始价格'
    kind_display = KIND_NAMES.get(kind, kind)
    label = ' · '.join(part for part in (shown, name if name != shown else '', kind_display, source_display, price) if part)
    return {**meta, 'display_symbol': shown, 'instrument_name': name, 'series_kind_display': kind_display,
            'source_display': source_display, 'price_basis_display': price,
            'presentation_description': label, **extra}
