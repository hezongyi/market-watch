"""Source identity and bounded M1 results shared by ingestion adapters."""

import hashlib
import json
from decimal import Decimal, InvalidOperation
from enum import StrEnum
from typing import Literal

import httpx
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictInt,
    StrictStr,
    model_serializer,
    model_validator,
)

from .volume import quantity

HistoryMode = Literal["base_m1", "base_d1", "native_periods"]
HistoryTimeframe = Literal["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN"]
HISTORY_FRAMES = ("M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN")
_V2_IDENTITY_FIELDS = {
    "identity_version", "mode", "base_frame", "source_family", "adjustment", "trading_date_rule",
}


class DatasetIdentity(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    source: str = Field(min_length=1, max_length=32)
    channel: str = Field(min_length=1, max_length=64)
    environment: str = Field(min_length=1, max_length=32)
    # An opaque fingerprint, never a raw account identifier or credential.
    account_scope: str = Field(pattern=r"^(public|sha256:[a-f0-9]{64})$", max_length=71)
    provider_symbol: str = Field(min_length=1, max_length=64)
    basis: str = Field(min_length=1, max_length=16)
    calendar_version: str = Field(min_length=1, max_length=80)
    identity_version: Literal[1, 2] = 1
    mode: HistoryMode = "base_m1"
    base_frame: Literal["M1", "D1"] | None = "M1"
    source_family: str | None = Field(default=None, min_length=1, max_length=80)
    adjustment: Literal["none", "qfq", "hfq", "supplier"] | None = None
    trading_date_rule: str | None = Field(default=None, min_length=1, max_length=80)

    @model_validator(mode="after")
    def validate_mode(self):
        if self.identity_version == 1:
            if (self.mode != "base_m1" or self.base_frame != "M1"
                    or any(value is not None for value in (
                        self.source_family, self.adjustment, self.trading_date_rule))):
                raise ValueError("New history modes require a v2 identity")
        elif (self.mode == "base_m1" or not self.source_family or not self.adjustment
                or not self.trading_date_rule
                or self.base_frame != ("D1" if self.mode == "base_d1" else None)):
            raise ValueError("v2 identity requires explicit mode, base, source and trading-date rules")
        if self.mode == "native_periods" and self.adjustment not in ("none", "supplier"):
            raise ValueError("Window-limited native history cannot maintain adjusted old prices")
        return self

    @model_serializer(mode="wrap")
    def serialize_identity(self, handler):
        value = handler(self)
        if self.identity_version == 1:
            # The old seven-field canonical bytes and all persisted v1 JSON
            # remain unchanged, including callers that serialize before hashing.
            return {key: item for key, item in value.items() if key not in _V2_IDENTITY_FIELDS}
        return value

    @property
    def key(self):
        content = json.dumps(self.model_dump(), sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(content.encode()).hexdigest()


class SourceIdentity(BaseModel):
    """Exact supplier endpoint/period parameters, independent of dataset reducers."""

    model_config = ConfigDict(frozen=True, extra="forbid")
    source: str = Field(min_length=1, max_length=32)
    channel: str = Field(min_length=1, max_length=64)
    environment: str = Field(min_length=1, max_length=32)
    account_scope: str = Field(pattern=r"^(public|sha256:[a-f0-9]{64})$", max_length=71)
    provider_symbol: str = Field(min_length=1, max_length=64)
    basis: str = Field(min_length=1, max_length=16)
    parameters: dict

    @property
    def key(self):
        return hashlib.sha256(json.dumps(self.model_dump(), sort_keys=True,
                                        separators=(",", ":")).encode()).hexdigest()


class RequestStatus(StrEnum):
    DATA = "data"
    EMPTY_SUCCESS = "empty_success"
    RATE_LIMITED = "rate_limited"
    UNAUTHORIZED = "unauthorized"
    TIMEOUT = "timeout"
    UNAVAILABLE = "unavailable"
    PROVIDER_MAINTENANCE = "provider_maintenance"
    INVALID_PAYLOAD = "invalid_payload"


class RequestResult(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    status: RequestStatus
    retry_at: StrictInt | None = Field(default=None, ge=0)

    # Optional safe transport evidence; old persisted results remain valid.
    operation: Literal["candles", "candles_latest"] | None = None
    http_status: int | None = Field(default=None, ge=100, le=599)
    reason_code: Literal["TIME_BOUNDARY", "TIMEOUT", "GATEWAY", "AUTH", "RATE_LIMIT", "UNKNOWN"] | None = None
    phase: Literal["response", "connect", "read", "tls", "request"] | None = None
    observed_at: StrictInt | None = Field(default=None, ge=0)
    window_start: StrictInt | None = Field(default=None, ge=0)
    window_end: StrictInt | None = Field(default=None, ge=0)

    @property
    def successful(self):
        return self.status in (RequestStatus.DATA, RequestStatus.EMPTY_SUCCESS)


class QuoteEvent(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    identity: DatasetIdentity
    bid: StrictStr | None = None
    ask: StrictStr | None = None
    source_time: StrictInt = Field(ge=0)
    received_at: StrictInt = Field(ge=0)
    tradeable: bool = Field(strict=True)
    connection_epoch: StrictInt = Field(gt=0)
    sequence: StrictInt = Field(gt=0)

    @model_validator(mode="after")
    def validate_prices(self):
        for raw in (self.bid, self.ask):
            if raw is None:
                continue
            try:
                value = Decimal(raw)
            except InvalidOperation as error:
                raise ValueError("Invalid quote price") from error
            if not value.is_finite() or not 0 < value < Decimal("1e14"):
                raise ValueError("Quote price must be positive and finite")
        return self


class SourceHealth(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    identity: DatasetIdentity
    connection: Literal["disconnected", "connecting", "connected", "recovering"]
    heartbeat_at: StrictInt | None = Field(default=None, ge=0)
    last_quote_at: StrictInt | None = Field(default=None, ge=0)
    last_confirmed_m1: StrictInt | None = Field(default=None, ge=0)
    tradeable: bool | None = Field(default=None, strict=True)
    cooldown_until: StrictInt | None = Field(default=None, ge=0)
    error: RequestStatus | None = None


class SourceSelection(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    logical_symbol: str = Field(pattern=r"^[A-Z0-9]{1,10}$")
    current: DatasetIdentity | None
    selection_epoch: StrictInt = Field(ge=0)
    reason: str = Field(min_length=1, max_length=200)
    effective_at: StrictInt = Field(ge=0)
    fallback_ready: bool = Field(default=False, strict=True)


class MarketRequestError(RuntimeError):
    """Safe to log: does not retain exception text, URLs or response bodies."""

    def __init__(self, result: RequestResult):
        self.result = result
        suffix = " (429)" if result.status == RequestStatus.RATE_LIMITED else ""
        super().__init__("Market request: " + result.status + suffix)


def failed_request(error, *, observed_at):
    if isinstance(error, MarketRequestError):
        return error.result
    status = RequestStatus.UNAVAILABLE
    retry_at = None
    if isinstance(error, httpx.HTTPStatusError):
        code = error.response.status_code
        if code == 429:
            status = RequestStatus.RATE_LIMITED
            from email.utils import parsedate_to_datetime

            value = error.response.headers.get("Retry-After", "")
            try:
                seconds = Decimal(value)
                if seconds.is_finite() and seconds >= 0:
                    retry_at = observed_at + int(seconds * 1000)
            except InvalidOperation:
                try:
                    retry_at = max(observed_at, int(parsedate_to_datetime(value).timestamp() * 1000))
                except (ValueError, TypeError, OverflowError):
                    pass
        elif code in (401, 403):
            status = RequestStatus.UNAUTHORIZED
        elif code == 503 and error.response.is_stream_consumed:
            # Classify only a bounded, explicit provider assertion. Do not read
            # a streaming error body here or expose response text in status/logs.
            content = error.response.content
            if len(content) <= 8192:
                try:
                    payload = error.response.json()
                    message = payload.get('errorMessage') if isinstance(payload, dict) else None
                    if isinstance(message, str) and 'maintenance' in message.lower():
                        status = RequestStatus.PROVIDER_MAINTENANCE
                except ValueError:
                    pass
    elif isinstance(error, (httpx.TimeoutException, TimeoutError)):
        status = RequestStatus.TIMEOUT
    elif isinstance(error, (ValueError, KeyError, TypeError)):
        status = RequestStatus.INVALID_PAYLOAD
    code = error.response.status_code if isinstance(error, httpx.HTTPStatusError) else None
    reason = ('AUTH' if status == RequestStatus.UNAUTHORIZED else 'RATE_LIMIT' if code == 429 else
              'GATEWAY' if code in (502, 504) else 'TIMEOUT' if status == RequestStatus.TIMEOUT else 'UNKNOWN')
    # Exact provider assertion only. Never retain arbitrary error text or URLs.
    if code == 400 and error.response.is_stream_consumed and len(error.response.content) <= 8192:
        try:
            body = error.response.json()
            if isinstance(body, dict) and body.get('errorMessage') == "Invalid value specified for 'to'. Time is in the future":
                reason, retry_at = 'TIME_BOUNDARY', observed_at + 5000
        except ValueError:
            pass
    phase = 'response' if code else 'connect' if isinstance(error, httpx.ConnectTimeout) else 'read' if isinstance(error, httpx.ReadTimeout) else 'request'
    return RequestResult(status=status, retry_at=retry_at, http_status=code,
                         reason_code=reason, phase=phase, observed_at=observed_at)


class MinuteRow(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    timestamp: StrictInt = Field(ge=0)
    open: StrictStr
    high: StrictStr
    low: StrictStr
    close: StrictStr
    volume: StrictStr | None = None
    complete: bool = Field(strict=True)

    @model_validator(mode="after")
    def validate_minute(self):
        if self.timestamp % 60000:
            raise ValueError("M1 start must be a UTC whole minute")
        from .domain import Candle
        from .storage import instant

        try:
            prices = [Decimal(getattr(self, field)) for field in ("open", "high", "low", "close")]
        except InvalidOperation as error:
            raise ValueError("Invalid Decimal price") from error
        if any(price.is_finite() and price >= Decimal("1e14") for price in prices):
            raise ValueError("Price exceeds storage range")
        Candle(instant(self.timestamp), instant(self.timestamp + 60000), *prices,
               complete=self.complete, volume=quantity(self.volume))
        return self


class CandleBatch(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    identity: DatasetIdentity
    window_start: StrictInt = Field(ge=0)
    window_end: StrictInt = Field(gt=0)
    observed_at: StrictInt = Field(ge=0)
    result: RequestResult
    volume_kind: Literal["quantity", "price_count", "tick_count", "base", "unavailable"]
    volume_unit: str | None = Field(max_length=40)
    rows: tuple[MinuteRow, ...] = Field(default=(), max_length=44640)
    checkpoint: StrictInt | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def validate_batch(self):
        if not 0 < self.window_end - self.window_start <= 31 * 86400000:
            raise ValueError("M1 batch must have a bounded half-open window of at most 31 days")
        if self.checkpoint is not None and not self.window_start <= self.checkpoint <= self.window_end:
            raise ValueError("Checkpoint must lie in the request window")
        if bool(self.rows) != (self.result.status == RequestStatus.DATA):
            raise ValueError("Only data results may contain rows; data results must contain rows")
        previous = -1
        for row in self.rows:
            quantity(row.volume, tick=self.volume_kind in ("price_count", "tick_count"))
            if self.volume_kind == "unavailable" and row.volume is not None:
                raise ValueError("Unavailable volume cannot contain a quantity")
            if not self.window_start <= row.timestamp < self.window_end:
                raise ValueError("M1 is outside the half-open window")
            if row.timestamp <= previous:
                raise ValueError("M1 timestamps must be strictly increasing without duplicates")
            previous = row.timestamp
        return self

    def ingestion_payload(self):
        if not self.result.successful:
            raise MarketRequestError(self.result)
        return {
            "identity": self.identity.model_dump(),
            "source": self.identity.source,
            "basis": self.identity.basis,
            "instrument": self.identity.provider_symbol,
            "window_start": self.window_start,
            "window_end": self.window_end,
            "observed_at": self.observed_at,
            "request_result": self.result.model_dump(mode="json"),
            "volume_kind": self.volume_kind,
            "volume_unit": self.volume_unit,
            # Observed minutes certify only themselves; empty is never coverage.
            "rows": [row.model_dump() for row in self.rows],
        }


class NativeBarRow(BaseModel):
    """A supplier period, never a minute disguised by its chart label.

    start/end are normalized chart bounds. source_label and trading_date retain
    the supplier's session assignment (especially futures night sessions).
    """

    model_config = ConfigDict(frozen=True, extra="forbid")

    timeframe: HistoryTimeframe
    start: StrictInt = Field(ge=0)
    end: StrictInt = Field(gt=0)
    open: StrictStr
    high: StrictStr
    low: StrictStr
    close: StrictStr
    volume: StrictStr | None = None
    source_label: StrictStr = Field(min_length=1, max_length=80)
    trading_date: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    complete: bool = Field(strict=True)
    confirmation: Literal["provider", "next_bar", "session_elapsed", "unconfirmed"]

    @model_validator(mode="after")
    def validate_bar(self):
        from datetime import date

        from .domain import Candle
        from .storage import instant

        if self.start >= self.end:
            raise ValueError("Native bar must have nonempty explicit bounds")
        if self.trading_date is not None:
            date.fromisoformat(self.trading_date)
        if self.timeframe in ("D1", "W1", "MN") and self.trading_date is None:
            raise ValueError("Calendar periods require the supplier trading date")
        if self.complete and self.confirmation == "unconfirmed":
            raise ValueError("Observed prices do not certify a closed supplier bar")
        try:
            prices = [Decimal(getattr(self, key)) for key in ("open", "high", "low", "close")]
        except InvalidOperation as error:
            raise ValueError("Invalid Decimal price") from error
        if any(price.is_finite() and price >= Decimal("1e14") for price in prices):
            raise ValueError("Price exceeds storage range")
        Candle(instant(self.start), instant(self.end), *prices,
               complete=self.complete, volume=quantity(self.volume))
        return self


class NativeCandleBatch(BaseModel):
    """Bounded native observations for exactly one immutable acquisition identity."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    identity: SourceIdentity
    timeframe: HistoryTimeframe
    window_start: StrictInt = Field(ge=0)
    window_end: StrictInt = Field(gt=0)
    observed_at: StrictInt = Field(ge=0)
    result: RequestResult
    volume_kind: Literal["quantity", "price_count", "tick_count", "base", "unavailable"]
    volume_unit: str | None = Field(max_length=40)
    rows: tuple[NativeBarRow, ...] = Field(default=(), max_length=100000)
    checkpoint: StrictInt | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def validate_batch(self):
        if not self.window_start < self.window_end:
            raise ValueError("Native batch requires a fixed nonempty half-open request window")
        if self.identity.parameters.get("timeframe") != self.timeframe:
            raise ValueError("Native batch timeframe differs from acquisition identity")
        if self.checkpoint is not None and not self.window_start <= self.checkpoint <= self.window_end:
            raise ValueError("Checkpoint must lie in the request window")
        if bool(self.rows) != (self.result.status == RequestStatus.DATA):
            raise ValueError("Only data results may contain rows; data results must contain rows")
        previous = -1
        for row in self.rows:
            quantity(row.volume, tick=self.volume_kind in ("price_count", "tick_count"))
            if self.volume_kind == "unavailable" and row.volume is not None:
                raise ValueError("Unavailable volume cannot contain a quantity")
            if (row.timeframe != self.timeframe or row.start <= previous
                    or not self.window_start <= row.start < self.window_end):
                raise ValueError("Native rows must match frame/window and be strictly ordered")
            if row.complete and row.end > self.observed_at:
                raise ValueError("A future supplier interval cannot be confirmed")
            previous = row.start
        return self
