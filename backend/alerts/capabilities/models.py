"""Bounded, documented agent input and output contracts."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Empty(Input):
    pass


class ManagedListQuery(Input):
    query: str = Field(default="", max_length=100)
    source: str | None = Field(default=None, max_length=32)
    calendar: Literal["ny17", "utc0"] | None = None
    asset_class: Literal["forex", "metal", "crypto", "index", "other", "unspecified"] | None = None
    status: Literal["all", "available", "preparing", "attention", "paused", "archived"] = "all"
    page: int = Field(default=1, ge=1)
    page_size: int = Field(default=25, ge=1, le=100)


class ManagedDatasetQuery(Input):
    dataset_id: str = Field(min_length=64, max_length=64)


class ManagedVersionQuery(Input):
    version_id: str = Field(min_length=1, max_length=36)


class ManagedBarsQuery(ManagedVersionQuery):
    timeframe: Literal["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN"] = "M1"
    before: int | None = Field(default=None, ge=0)
    count: int = Field(default=2000, ge=1, le=5000)


class ManagedCoverageQuery(ManagedVersionQuery):
    page: int = Field(default=1, ge=1)
    page_size: int = Field(default=25, ge=1, le=100)


class ManagedTasksQuery(Input):
    query: str = Field(default="", max_length=100)
    source: str | None = Field(default=None, max_length=32)
    status: Literal["all", "active", "attention", "history", "paused"] = "all"
    dataset_id: str | None = Field(default=None, min_length=64, max_length=64)
    page: int = Field(default=1, ge=1)
    page_size: int = Field(default=25, ge=1, le=100)


class ManagedCreationQuery(Input):
    request_id: str = Field(min_length=1, max_length=100)
    source: Literal["dukascopy", "oanda"]
    provider_symbol: str = Field(min_length=1, max_length=64)
    asset_class: Literal["forex", "metal", "crypto", "index", "other", "unspecified"] = "forex"
    aggregation_calendar: Literal["ny17", "utc0"] | None = None


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
    params: dict[str, int | float | str] = Field(default_factory=dict)


class BarsQuery(QuoteQuery):
    timeframe: Literal["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN"] = "H1"
    before: int | None = Field(
        default=None,
        gt=0,
        description="Exclusive millisecond cursor: managed UTC start, provider native chart time",
    )
    limit: int = Field(default=300, ge=1, le=2000)
    published: bool = False
    dataset_start: int | None = Field(default=None, ge=0)


class IndicatorsQuery(BarsQuery):
    instrument: str = Field(
        min_length=1, max_length=80,
        description="Base instrument/composite ID; history requires an immutable version ID or MWH:<version_id>",
    )
    series_kind: Literal["managed", "provider", "composite", "history"] = "managed"
    indicator_input_policy: Literal["observed_display_v1", "strict_confirmed_v1"] = Field(
        default="observed_display_v1",
        description="History/composite default to actual observed bars, tolerating missing M1 and whole periods. Select strict_confirmed_v1 to require complete coverage. Managed/provider retain their existing strict policy.",
    )
    provisional: bool = Field(default=False, description="Opt in to recomputed last incomplete candle; values are marked provisional")
    calculation_origin: int | None = Field(default=None, ge=0, description="Reuse the returned provider calculation_origin to pin recursive history")
    composite_revision_id: str | None = Field(default=None, min_length=1, max_length=36)
    input_revision: int | None = Field(default=None, ge=0, strict=True)
    indicators: list[IndicatorSpec] = Field(min_length=1, max_length=12)

    @model_validator(mode="before")
    @classmethod
    def default_input_policy(cls, value):
        if isinstance(value, dict) and value.get("series_kind", "managed") in ("managed", "provider"):
            return {"indicator_input_policy": "strict_confirmed_v1", **value}
        return value

    @model_validator(mode="after")
    def validate_composite_options(self):
        if self.instrument.startswith("MWC:"):
            if self.series_kind != "composite":
                raise ValueError("MWC 标识须显式指定 series_kind=composite")
            from ..chart_series import decode

            self.instrument = decode(self.instrument)[0]
        if self.series_kind == "composite":
            if self.published or self.dataset_start is not None or self.calculation_origin is not None:
                raise ValueError("组合指标不支持 published、dataset_start 或 calculation_origin")
            if self.input_revision is not None and not self.composite_revision_id:
                raise ValueError("指定 input_revision 时必须指定 composite_revision_id")
            if self.provisional and self.input_revision is not None:
                raise ValueError("provisional 与 input_revision 不能同时使用")
        elif self.composite_revision_id is not None or self.input_revision is not None:
            raise ValueError("组合修订参数只适用于 series_kind=composite")
        return self

    @model_validator(mode="after")
    def validate_history_options(self):
        if self.instrument.startswith("MWH:") and self.series_kind != "history":
            raise ValueError("MWH 标识须显式指定 series_kind=history")
        if self.series_kind == "history":
            from ..chart_series import decode

            ticker = self.instrument if self.instrument.startswith("MWH:") else "MWH:" + self.instrument
            self.instrument = decode(ticker)[0]
            if self.published or self.dataset_start is not None or self.calculation_origin is not None:
                raise ValueError("固定历史指标不支持 published、dataset_start 或 calculation_origin")
        return self




class SignalsQuery(PageQuery):
    instrument: str | None = Field(default=None, max_length=80)
    watch_id: str | None = Field(default=None, max_length=40)


class WorkspacesQuery(PageQuery):
    engine: Literal["native"] = "native"


class DrawingsQuery(Input):
    workspace_id: str = Field(min_length=1, max_length=40)
    engine: Literal["native"] = "native"


class WriteInput(Input):
    idempotency_key: str = Field(min_length=1, max_length=100)








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


class ValuePoint(Record):
    time: int
    value: float | None
    provisional: bool = False


class IndicatorSeries(Record):
    key: str
    type: str
    values: list[ValuePoint]


class InputEvidence(Record):
    revision_id: str | None = None
    input_revision: int | None = None
    history_version_id: str | None = None
    display_snapshot_id: str | None = None
    provider_snapshot_id: str | None = None
    cache_revision: int | None = None
    calculation_origin: int | None = None


class Calculation(Record):
    run_id: str | None = None
    status: str | None = None
    visible_complete: bool | None = None
    calculation_origin: int | None = None
    algorithm: str | None = None
    coverage: list[dict] = Field(default_factory=list)
    required_coverage: list[dict] = Field(default_factory=list)
    cursor: int | None = None
    target_end: int | None = None
    error: str | None = None
    next_at: int | None = None
    input_evidence: InputEvidence | None = None


class Dependency(Record):
    start: int
    dependency_origin: int | None = None
    seam_dependency: bool | None = None
    initialized: bool | None = None
    provisional: bool | None = None


class IndicatorResult(Record):
    name: str
    version: str
    params: dict[str, int | float | str]
    series: list[IndicatorSeries]
    calculation: Calculation | None = None
    dependencies: list[Dependency] = Field(default_factory=list)


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
    cursor_coordinate: Literal["utc_ms", "native_chart_time_ms"] = "utc_ms"
    coverage_scope: str = "returned_page"
    incomplete_count: int = 0
    gaps: list[dict[str, int]] = Field(default_factory=list)
    interval_breaks: list[dict[str, int]] = Field(default_factory=list)
    gap_assessment: Literal["trading_calendar", "unknown_calendar"] = "trading_calendar"
    page: ChartPage


class IndicatorBar(BarResult):
    time_closed: bool | None = None
    source_confirmed: bool | None = None
    coverage_complete: bool | None = None
    chart_time: int | None = None
    segments: list[dict] = Field(default_factory=list)


class HistoryInputManifest(Record):
    version_id: str
    checksum: str


class IndicatorsPage(ChartPage):
    bars: list[IndicatorBar]
    version_id: str | None = None
    input_manifest: HistoryInputManifest | None = None
    source: str | None = None
    composite_id: str | None = None
    revision_id: str | None = None
    input_revision: int | None = None
    history_version_id: str | None = None
    history_checksum: str | None = None
    seam: int | None = None
    rule_version: str | None = None
    display_snapshot_id: str | None = None
    provider_snapshot_id: str | None = None
    calculation_origin: int | None = None
    calculation: Calculation | None = None
    indicator_progress: list[Calculation] = Field(default_factory=list)
    pending: list[str] = Field(default_factory=list)


class IndicatorsResult(BarsResult):
    page: IndicatorsPage


class CatalogResult(BaseModel):
    indicators: dict[str, dict]
    policy: str






class SignalResult(Record):
    id: str
    instrument_id: str
    watch_id: str | None
    chart_alert_id: str | None
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
