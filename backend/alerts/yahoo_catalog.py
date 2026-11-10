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
        row.metadata_json = {**previous, **details, "metadata_observed_at": details["updated_at"]}
        if previous.get("name_zh_origin") == "manual":
            row.metadata_json = {**row.metadata_json, "name_zh": previous["name_zh"], "name_zh_origin": "manual"}
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
            now_ms() - details.get("metadata_observed_at", details.get("updated_at", row.updated_at))
            >= settings.yahoo_metadata_ttl_seconds * 1000
            or not details.get("adjustment")
        )
    if cached_only and not details.get("adjustment"):
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


# Public partitions whose pagination/coverage is documented in the research.
# US equity is attempted but never published if Yahoo's 10k cap truncates it.
PARTITIONS = {"crypto-usd": ("ALL_CRYPTOCURRENCIES_US", "CRYPTOCURRENCY"),
              "equity-us": ("equity", "EQUITY")}


def fetch_partition(scr_id, kind):
    import httpx

    from .provider_yahoo import stable_id

    url = "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved"
    records, total, start = {}, None, 0
    from . import runtime_health
    with httpx.Client(timeout=30, proxy=settings.yahoo_proxy or settings.market_proxy or None,
                      trust_env=False) as client:
        while total is None or start < total:
            response = client.get(url, params={"scrIds": scr_id, "count": 250,
                "start": start, "useRecordsResponse": "true", "sortField": "ticker", "sortType": "ASC"}, headers={"User-Agent": "Mozilla/5.0"})
            response.raise_for_status()
            runtime_health.progress()
            data = response.json()["finance"]["result"][0]
            reported = data["total"]
            if total is None:
                total = reported
            if reported != total or data["start"] != start or total > 10000:
                raise ValueError("供应商分区总数变化或超过10000条分页上限；未发布，保留旧快照")
            page = data.get("records", data.get("quotes", []))
            if not page:
                raise ValueError("供应商分页提前结束；保留旧快照")
            for item in page:
                symbol = item.get("ticker") or item.get("symbol")
                if not symbol or symbol in records:
                    raise ValueError("供应商分页重复或缺少代码；保留旧快照")
                records[symbol] = {"id": stable_id(symbol), "symbol": symbol,
                    "label": item.get("companyName") or item.get("longName") or item.get("shortName") or symbol,
                    "asset_type": kind, "precision": 8, "calendar": "yahoo",
                    "metadata_json": {"exchange": item.get("exchange") or ("CCC" if kind == "CRYPTOCURRENCY" else "US"),
                        "coverage_note": "USD quotes on CCC" if kind == "CRYPTOCURRENCY" else "US equity screener"}}
            start += len(page)
    if len(records) != total:
        raise ValueError("供应商总数与唯一代码数不符；保留旧快照")
    # The declared public partitions exclude A/H equities, including stale rows.
    items = [row for row in records.values() if not row["symbol"].upper().endswith((".HK", ".SS", ".SZ", ".BJ"))]
    return items, total


def refresh():
    from .catalog_sync import failed, publish

    if not settings.yahoo_enabled:
        raise ValueError("Yahoo 行情源未启用")
    results = []
    for partition, (scr_id, kind) in PARTITIONS.items():
        try:
            records, total = fetch_partition(scr_id, kind)
            results.append(publish("yahoo", records, partition=partition, complete=True,
                advertised_total=total, origin="Yahoo screener: " + scr_id, mark_missing=True))
        except ValueError as error:
            results.append(failed("yahoo", partition=partition, reason=str(error)))
        except Exception:
            results.append(failed("yahoo", partition=partition))
    return {"source": "yahoo", "partitions": results,
        "coverage_note": "已声明公开分区；不代表全球资产全集；排除沪深京及港股"}
