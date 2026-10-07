"""Read-only composite tools share browser management and fixed chart snapshots."""

from typing import Literal

from pydantic import Field

from ..composite_center import candidates, detail, list_composites, mappings, read_attempts
from ..composite_chart import chart_page
from .history import invoke
from .models import Input, ManagedDatasetQuery, Record
from .registry import Capability


class CompositeListQuery(Input):
    query: str = Field(default="", max_length=100)
    page: int = Field(default=1, ge=1)
    page_size: int = Field(default=25, ge=1, le=100)


class SeriesSearchQuery(Input):
    query: str = Field(default="", max_length=100)
    kind: Literal["all", "provider", "history", "composite"] = "all"
    limit: int = Field(default=100, ge=1, le=250)
    page_size: int | None = Field(default=None, ge=1, le=250)
    offset: int = Field(default=0, ge=0, le=1000000)
    source: Literal["dukascopy", "oanda", "binance", "yahoo"] | None = None
    calendar: Literal["ny17", "utc0"] | None = None


class CompositeQuery(Input):
    composite_id: str = Field(min_length=64, max_length=64)


class CompositeRequestsQuery(CompositeQuery):
    page: int = Field(default=1, ge=1)
    page_size: int = Field(default=25, ge=1, le=100)


class CompositeBarsQuery(CompositeQuery):
    timeframe: Literal["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN"] = "M1"
    before: int | None = Field(default=None, ge=0)
    count: int = Field(default=300, ge=1, le=2000)
    revision_id: str | None = Field(default=None, min_length=1, max_length=36)
    input_revision: int | None = Field(default=None, ge=0)
    provisional: bool = False


def register_composite(registry):
    from ..composite_quotes import get_snapshot
    from ..market_data import search_series, search_series_page

    def series_query(ctx, q):
        if q.page_size is not None or q.offset or q.source or q.calendar:
            return search_series_page(q.query, kind=q.kind, page_size=q.page_size or q.limit,
                offset=q.offset, source=q.source, calendar=q.calendar)
        return {"items": search_series(q.query, kind=q.kind, limit=q.limit)}

    registry.register(Capability("series_search",
        "Unified qualified platform, fixed published history and eligible composite candidates. Search and resolve do not create a composite or live demand; history ticker fixes a version. Pagination or filters require an explicit provider/history/composite kind. Paged results use next_offset; an empty qualified page can still continue. Legacy all returns an interleaved list.",
        SeriesSearchQuery, Record, frozenset({"market:read"}), "read",
        series_query))
    entries = [
        ("composite_get_quote", "Stored composite price: fresh owner-fenced sampled Bid, otherwise saved confirmed M1 close. Exact price, fixed revision, source evidence and separate quote/tail readiness. No creation, live demand or supplier IO.", CompositeQuery,
         lambda ctx, q: invoke(get_snapshot, q.composite_id)),
        ("composite_list", "Pure paginated saved composites; no creation, demand or supplier request.", CompositeListQuery,
         lambda ctx, q: invoke(list_composites, **q.model_dump())),
        ("composite_list_candidates", "Pure managed history candidates with explicit saved mapping status. Search never creates a composite.", CompositeListQuery,
         lambda ctx, q: invoke(candidates, **q.model_dump())),
        ("composite_get_mappings", "Read explicit versioned product/basis mappings; no subscription.", ManagedDatasetQuery,
         lambda ctx, q: invoke(mappings, q.dataset_id)),
        ("composite_get", "Fixed baseline, seam, preparation and separate quote, confirmed-tail and strategy health facts.", CompositeQuery,
         lambda ctx, q: invoke(detail, q.composite_id)),
        ("composite_get_requests", "Read durable bounded preparation query outcomes, cache reads and failures; distinct from coverage.", CompositeRequestsQuery,
         lambda ctx, q: invoke(read_attempts, **q.model_dump())),
        ("composite_get_bars", "Fixed composite and confirmed input revision chart bars. Stitch M1 then aggregate; independent time/confirmation/coverage and seam flags. Exclusive UTC before cursor; optional stream provisional snapshots cannot be mixed with fixed input. No live demand.", CompositeBarsQuery,
         lambda ctx, q: invoke(chart_page, q.composite_id, q.timeframe, **q.model_dump(exclude={"composite_id", "timeframe"}))),
    ]
    for name, description, model, handler in entries:
        registry.register(Capability(name, description, model, Record, frozenset({"market:read"}), "read", handler))
