"""Local-first Yahoo catalog, validated expansion and daily event revisions."""

import threading
import time
from concurrent.futures import Future

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from .config import settings
from .market_names import display_code
from .query_errors import QueryError
from .storage import (
    MarketCatalog,
    ProviderBar,
    ProviderDataset,
    ProviderInterest,
    now_ms,
    transaction,
)
from .yahoo_aliases import ALIASES

_LOCK = threading.Lock()
_INFLIGHT = {}
_SEARCH = {}


def seed():
    if not settings.yahoo_enabled:
        return
    from .provider_yahoo import stable_id

    with transaction() as db:
        insert = pg_insert if db.get_bind().dialect.name == "postgresql" else sqlite_insert
        for symbol, (label, kind) in ALIASES.items():
            ident = stable_id(symbol)
            row = db.get(MarketCatalog, ident)
            if row and row.symbol != symbol:
                raise ValueError("Yahoo 稳定身份冲突")
            if row is None:
                db.execute(
                    insert(MarketCatalog.__table__).values(
                        id=ident,
                        source="yahoo",
                        symbol=symbol,
                        label=label,
                        asset_type=kind,
                        precision=8,
                        calendar="yahoo",
                        available=True,
                        metadata_json={},
                        updated_at=0,
                    ).on_conflict_do_nothing(index_elements=["id"])
                )
                # The other initializer may have inserted while we read. Keep
                # the identity collision check without overwriting its metadata.
                if db.get(MarketCatalog, ident).symbol != symbol:
                    raise ValueError("Yahoo 稳定身份冲突")


def _store(details):
    from .provider_yahoo import stable_id

    ident = stable_id(details["symbol"])
    with transaction() as db:
        row = db.get(MarketCatalog, ident)
        if row and row.symbol != details["symbol"]:
            raise ValueError("Yahoo 稳定身份冲突")
        previous = row.metadata_json if row else {}
        if row is None:
            row = MarketCatalog(id=ident, source="yahoo", symbol=details["symbol"])
            db.add(row)
        old_event, new_event = previous.get("event_revision"), details.get("event_revision")
        if details["adjustment"] == "auto" and previous and new_event and old_event != new_event:
            for dataset in db.scalars(
                select(ProviderDataset).where(
                    ProviderDataset.source == "yahoo", ProviderDataset.symbol == details["symbol"]
                ).with_for_update()
            ):
                if dataset.metadata_json.get("adjustment") != "auto":
                    continue
                dataset.coverage = []
                dataset.earliest = False
                dataset.latest_at = 0
                dataset.generation += 1
                dataset.revision += 1
                dataset.updated_at = now_ms()
                dataset.lease_token = None
                dataset.lease_until = 0
                dataset.metadata_json = {
                    **dataset.metadata_json,
                    **details,
                    "revalidation_generation": dataset.generation,
                    "invalidated_at": now_ms(),
                }
                # With coverage revoked, no old adjusted prices can be stitched
                # into a new observation, including sparse revised responses.
                db.execute(delete(ProviderBar).where(ProviderBar.dataset_id == dataset.id))
                for interest in db.scalars(
                    select(ProviderInterest).where(ProviderInterest.dataset_id == dataset.id)
                ):
                    interest.targets = [
                        {**t, "done": False, "next_at": 0, "generation": t.get("generation", 0) + 1}
                        for t in interest.targets
                    ]
                    interest.next_poll = 0
        row.label = ALIASES.get(details["symbol"], (details["english_name"],))[0]
        row.asset_type = details["asset_type"]
        row.precision = 8  # preserve fractional market values; no priceHint rounding
        row.calendar = "yahoo"
        row.available = True
        row.metadata_json = {**{key: previous[key] for key in (
            "archive_verified_frames", "archive_probes") if key in previous}, **details}
        row.updated_at = details["updated_at"]
    return ident


def chart_metadata(ident, *, deadline=None, cached_only=False):
    from .chart_series import decode
    from .provider_yahoo import display_precision
    ident = decode(ident)[0]
    if not settings.yahoo_enabled:
        raise QueryError(422, "Yahoo 行情源未启用")
    deadline = deadline or time.monotonic() + settings.provider_request_seconds
    with transaction() as db:
        row = db.get(MarketCatalog, ident)
        if row is None or row.source != "yahoo":
            raise QueryError(404, "未知 Yahoo 品种")
        symbol, name, details, precision = (
            row.symbol,
            row.label,
            dict(row.metadata_json),
            row.precision,
        )
        expired = (
            now_ms() - row.updated_at >= settings.yahoo_metadata_ttl_seconds * 1000 or not details
        )
    if cached_only and not details.get('adjustment'):
        raise QueryError(503, 'Yahoo 本地元信息尚未就绪，请先加载图表')
    if expired and not cached_only:
        with _LOCK:
            future = _INFLIGHT.get(ident)
            owner = future is None
            if owner:
                future = Future()
                _INFLIGHT[ident] = future
        if owner:
            try:
                from .provider_yahoo import metadata

                details = metadata(symbol, deadline=deadline)
                _store(details)
                future.set_result(details)
            except Exception as error:
                future.set_exception(error)
                raise
            finally:
                with _LOCK:
                    _INFLIGHT.pop(ident, None)
        else:
            details = future.result(timeout=max(0, deadline - time.monotonic()))
    return {
        **details,
        "id": ident,
        "name": name,
        "source": "yahoo",
        "symbol": symbol,
        "display_symbol": display_code(symbol, "yahoo", details.get("asset_type")),
        "basis": "adjusted" if details["adjustment"] == "auto" else "last",
        "calendar": "yahoo",
        "precision": max(8, precision),
        "display_precision": display_precision(details),
        "series_kind": "provider",
        "series_kinds": ["provider"],
    }


def search(query):
    """Known catalog remains available if remote search or metadata fails."""
    if not settings.yahoo_enabled or not query.strip():
        return "local"
    query = query.strip()[:100]
    with _LOCK:
        cached = _SEARCH.get(query.upper())
        if cached and cached[0] > time.monotonic():
            return cached[1]
    status = "ok"
    try:
        from .provider_yahoo import search_metadata

        deadline = time.monotonic() + settings.provider_request_seconds
        matches = search_metadata(query, deadline=deadline)
        for match in matches:
            # Only the selected/first bounded candidates need full metadata.
            # Search stores verified type/exchange before later chart resolve.
            details = {
                "symbol": match["symbol"].upper(),
                "english_name": match.get("longname") or match.get("shortname") or match["symbol"],
                "asset_type": match["quoteType"],
                "search_exchange": match.get("exchange"),
            }
            from .provider_yahoo import stable_id

            with transaction() as db:
                ident = stable_id(details["symbol"])
                old = db.get(MarketCatalog, ident)
                if old and old.symbol != details["symbol"]:
                    raise ValueError("Yahoo 稳定身份冲突")
                if not old:
                    db.add(
                        MarketCatalog(
                            id=ident,
                            source="yahoo",
                            symbol=details["symbol"],
                            label=details["english_name"],
                            asset_type=details["asset_type"],
                            precision=8,
                            calendar="yahoo",
                            metadata_json={},
                            updated_at=0,
                            available=True,
                        )
                    )
    except Exception:
        status = "failed"
    with _LOCK:
        _SEARCH[query.upper()] = (time.monotonic() + 300, status)
        while len(_SEARCH) > 128:
            _SEARCH.pop(next(iter(_SEARCH)))
    return status
