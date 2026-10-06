"""Bounded, documented agent input and output contracts."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from ..business import WatchInput


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Empty(Input):
    pass


class PageQuery(Input):
    limit: int = Field(default=100, ge=1, le=500)
    offset: int = Field(default=0, ge=0, le=100000)


class InstrumentQuery(PageQuery):
    query: str = Field(default="", max_length=80)
    series_kind: Literal["managed", "provider"] = "managed"


class QuoteQuery(Input):
    instrument: str = Field(min_length=1, max_length=80)
    series_kind: Literal["managed", "provider"] = "managed"


class IndicatorSpec(Input):
    name: str = Field(min_length=1, max_length=80)
    version: str = "1"
    params: dict[str, int | float] = Field(default_factory=dict)


class BarsQuery(QuoteQuery):
    timeframe: Literal["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN"] = "H1"
    before: int | None = Field(default=None, gt=0, description="Exclusive UTC millisecond cursor")
    limit: int = Field(default=300, ge=1, le=2000)
    published: bool = False
    dataset_start: int | None = Field(default=None, ge=0)


class IndicatorsQuery(BarsQuery):
    indicators: list[IndicatorSpec] = Field(min_length=1, max_length=12)


class AlertQuery(PageQuery):
    instrument: str | None = Field(default=None, max_length=80)
    status: Literal["active", "cancelled", "triggered", "paused"] | None = None


class SignalsQuery(PageQuery):
    instrument: str | None = Field(default=None, max_length=80)
    watch_id: str | None = Field(default=None, max_length=40)


class WorkspacesQuery(PageQuery):
    engine: Literal["native", "legacy"] = "native"


class DrawingsQuery(Input):
    workspace_id: str = Field(min_length=1, max_length=40)
    engine: Literal["native", "legacy"] = "native"


class WriteInput(Input):
    idempotency_key: str = Field(min_length=1, max_length=100)


class AgentWatchInput(WatchInput):
    model_config = ConfigDict(extra="forbid")


class CreateAlert(WriteInput):
    watch: AgentWatchInput


class CancelAlert(WriteInput):
    watch_id: str = Field(min_length=1, max_length=40)


class AckNotification(WriteInput):
    notification_id: str = Field(min_length=1, max_length=40)


class Record(BaseModel):
    model_config = ConfigDict(extra="allow")


class InstrumentResult(Record):
    id: str
    source: str
    series_kinds: list[str] = Field(default_factory=list)


class InstrumentsResult(BaseModel):
    items: list[InstrumentResult]
    next_offset: int | None
    queried_at: int


class QuoteResult(BaseModel):
    instrument: str
    source: str
    series_kind: str
    basis: str
    price: str
    price_type: str
    observed_at: int
    queried_at: int
    quality: str
    age_seconds: int
    calendar: str
    precision: int
    delay_seconds: int | None = None
    market_open: bool | None = None
    is_stale: bool = False


class BarResult(Record):
    start: int
    end: int
    open: str
    high: str
    low: str
    close: str
    complete: bool
    revision: int = 0


class ValuePoint(BaseModel):
    time: int
    value: float | None


class IndicatorSeries(Record):
    key: str
    type: str
    values: list[ValuePoint]


class IndicatorResult(Record):
    name: str
    version: str
    params: dict[str, int | float]
    series: list[IndicatorSeries]


class ChartPage(Record):
    bars: list[BarResult]
    indicators: list[IndicatorResult]
    has_more: bool
    origin: int | None = None
    history_revision: str | None = None
    cache_revision: int | None = None
    basis: str
    calendar: str
    as_of: int


class BarsResult(BaseModel):
    instrument: str
    source: str
    series_kind: str
    timeframe: str
    price_type: str
    queried_at: int
    quality: str
    next_before: int | None
    coverage_scope: str = "returned_page"
    incomplete_count: int = 0
    gaps: list[dict[str, int]] = Field(default_factory=list)
    page: ChartPage


class CatalogResult(BaseModel):
    indicators: dict[str, dict]
    policy: str


class WatchResult(Record):
    id: str
    instrument_id: str
    name: str
    rule: dict
    status: str


class AlertsResult(BaseModel):
    items: list[WatchResult]
    next_offset: int | None


class SignalResult(Record):
    id: str
    instrument_id: str
    watch_id: str
    occurred_at: int
    price: str
    notification_id: str
    notification_status: str


class SignalsResult(BaseModel):
    items: list[SignalResult]
    next_offset: int | None


class NotificationResult(BaseModel):
    id: str
    status: str


class WorkspaceResult(BaseModel):
    id: str
    name: str
    revision: int
    updated_at: int
    engine: str
    projection_available: bool


class WorkspacesResult(BaseModel):
    items: list[WorkspaceResult]
    next_offset: int | None


class Anchor(BaseModel):
    time: int | float | None
    price: str


class DrawingResult(BaseModel):
    object_id: str
    object_type: str
    supported: bool
    anchors: list[Anchor]
    reason: str | None = None


class DrawingChart(BaseModel):
    chart_id: str
    chart_index: int | None = None
    instrument: str
    source: str | None
    series_kind: str
    timeframe: str
    drawings: list[DrawingResult]
    status: str = "supported"
    time_coordinate: str = "native_chart_time_ms"


class DrawingsResult(BaseModel):
    workspace_id: str
    revision: int
    saved_at: int
    engine: str
    charts: list[DrawingChart]
    visibility: str = "saved_only"
    projection_version: int = 1


class StatusResult(BaseModel):
    mcp_enabled: bool
    queried_at: int
    active_alerts: int
    recent_signals: int
    delivery_enabled: bool
    tools: list[str]
