"""Read-only, batched notification presentation. Never establishes a series.

The application has one authenticated subject (admin); composite registry reads
are restricted to its existing workspace:default scope. Names never enter identity.
"""
import re

from sqlalchemy import and_, exists, func, or_, select

from .market_names import code_search, display_code
from .storage import (
    CompositeRevision,
    HistoryReclamation,
    HistoryVersion,
    Instrument,
    MarketCatalog,
    MarketComposite,
    MarketDataset,
)

KINDS = {'provider', 'history', 'composite', 'managed'}
KIND_LABELS = {'provider':'平台行情', 'history':'固定历史', 'composite':'组合行情', 'managed':'自建行情'}
PREFIXES = {'MWC:': 'composite', 'MWH:': 'history', 'MWP:': 'provider'}


def snapshot(meta, *, provenance='event_snapshot'):
    kind = meta.get('series_kind')
    symbol = meta.get('display_symbol') or meta.get('symbol')
    if kind not in KINDS or not isinstance(symbol, str) or not symbol.strip() or len(symbol) > 80:
        return None
    if re.fullmatch(r'[a-f0-9]{32,64}|[a-f0-9-]{36}', symbol, re.I):
        return None
    label = meta.get('label') or meta.get('name') or ''
    return {'series_kind': kind, 'symbol': display_code(symbol),
            'label': label[:120] if isinstance(label, str) else '', 'provenance': provenance}


def identity(item):
    raw = item.get('instrument') or item.get('context', {}).get('instrument') or ''
    kind = item.get('context', {}).get('series_kind') or None
    for prefix, prefix_kind in PREFIXES.items():
        if raw.startswith(prefix):
            value = raw[len(prefix):]
            return value.lower() if re.fullmatch(r'[a-f0-9]{64}', value, re.I) else value, prefix_kind
    return raw.lower() if re.fullmatch(r'[a-f0-9]{64}', raw, re.I) else raw, kind


def registrations():
    """SQL read plans shared by page hydration and pre-pagination name search."""
    yield 'composite', select(MarketComposite.id, MarketDataset.logical_symbol, Instrument.label).join(
        CompositeRevision, CompositeRevision.id == MarketComposite.active_revision_id).join(
        HistoryVersion, HistoryVersion.id == CompositeRevision.history_version_id).join(
        MarketDataset, MarketDataset.id == HistoryVersion.dataset_id).join(
        Instrument, Instrument.id == MarketDataset.instrument_id).where(
        MarketComposite.permission_scope == 'workspace:default')
    yield 'history', select(HistoryVersion.id, MarketDataset.logical_symbol, Instrument.label).join(
        MarketDataset, MarketDataset.id == HistoryVersion.dataset_id).join(
        Instrument, Instrument.id == MarketDataset.instrument_id).where(
        HistoryVersion.status == 'published', ~exists(select(HistoryReclamation.version_id).where(
            HistoryReclamation.version_id == HistoryVersion.id)))
    yield 'managed', select(Instrument.id, Instrument.symbol, Instrument.label)
    yield 'provider', select(MarketCatalog.id, MarketCatalog.symbol, MarketCatalog.label).where(MarketCatalog.available.is_(True))


def enrich(db, items, *, subject='admin'):
    items = [dict(item) for item in items]
    if subject != 'admin':
        return items
    pending = [item for item in items if not snapshot(item.get('instrument_display') or {})]
    identities = {identity(item) for item in pending}
    resolved = {}
    for kind, query in registrations():
        ids = {raw for raw, wanted in identities if raw and wanted in (None, kind)}
        if not ids:
            continue
        column = query.selected_columns[0]
        for ident, symbol, label in db.execute(query.where(column.in_(ids))):
            resolved[(ident, kind)] = snapshot({'series_kind': kind, 'symbol': symbol, 'label': label}, provenance='resolved_current')
    for item in items:
        display = snapshot(item.get('instrument_display') or {}, provenance=(item.get('instrument_display') or {}).get('provenance', 'event_snapshot'))
        if not display:
            raw, kind = identity(item)
            choices = [value for (ident, actual), value in resolved.items() if ident == raw and kind in (None, actual)]
            display = choices[0] if len(choices) == 1 else None
        if display:
            item['instrument_display'] = display
    return items


def capture(db, item):
    display = enrich(db, [item])[0].get('instrument_display')
    return {**display, 'provenance': 'event_snapshot'} if display else None


def search_clause(event, term, *, subject='admin'):
    """Correlated EXISTS filters before LIMIT; no identity rewriting or N+1."""
    display = event.body['instrument_display']
    clauses = [code_search(term, display['symbol'].as_string(), display['label'].as_string())]
    matching_kinds = [kind for kind,label in KIND_LABELS.items() if term.strip().lower() in (kind + ' ' + label).lower()]
    if matching_kinds:
        clauses.append(display['series_kind'].as_string().in_(matching_kinds))
    if subject != 'admin':
        return or_(*clauses)
    for kind, query in registrations():
        registry = query.subquery()
        ident, symbol, label = list(registry.c)
        prefixed = next((prefix for prefix, value in PREFIXES.items() if value == kind), '')
        kind_value = event.body['context']['series_kind'].as_string()
        match = and_(or_(func.lower(event.instrument) == func.lower(ident), func.lower(event.instrument) == prefixed.lower() + func.lower(ident)) if prefixed else event.instrument == ident,
                     or_(kind_value.is_(None), kind_value == kind), (True if kind in matching_kinds else code_search(term, symbol, label)))
        clauses.append(and_(display['symbol'].as_string().is_(None), exists(select(ident).where(match))))
    return or_(*clauses)
