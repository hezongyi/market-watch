"""Account-scoped candle snapshots, independent of quotes and stream lifecycle.

Latest is an observation, never a query-coverage checkpoint. The owner supplies
its generation, demand revision and sequence before I/O and must fence them again
at commit. This adapter performs no market writes or consumer evaluation.
"""

import hashlib
import json
import time
from decimal import Decimal, InvalidOperation
from typing import Literal

import httpx
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictInt,
    StrictStr,
    field_validator,
    model_validator,
)

from .market_contracts import CandleBatch, DatasetIdentity, MinuteRow, RequestResult, failed_request
from .market_resources import cooldown, request_slot
from .native_series import BASES, OandaParameters, interval_end
from .oanda_stream import OandaPractice, TransportTrace, timestamp
from .provider_deadline import request_deadline
from .source_registry import SourceIdentity
from .volume import quantity

# Only the measured 12-specification envelope is enabled initially. Increasing
# this requires a supplier-limit and budget check, rather than silent splitting.
MAX_SPECIFICATIONS = 12
FRAMES = {"M1": "M1", "M5": "M5", "M15": "M15", "M30": "M30", "H1": "H1",
          "H4": "H4", "D": "D1", "W": "W1", "M": "MN"}
SIDES = {"B": "bid", "A": "ask", "M": "mid"}


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def live_demand_revision(identities):
    """Return the stable request-generation token for one live specification set.

    Dataset identities include the account scope, price side, calendar and all
    source parameters. Hashing their sorted keys lets the publisher fence an
    in-flight response without persisting a second mutable demand row.
    """
    return digest(sorted(identity.key for identity in identities))


def decimal_text(value):
    """Canonical exact strings, with no float conversion or Decimal rounding."""
    if not isinstance(value, str) or len(value) > 80:
        raise ValueError("Candle prices and units must be Decimal strings")
    try:
        number = Decimal(value)
    except InvalidOperation:
        raise ValueError("Invalid candle Decimal") from None
    if (not number.is_finite() or not 0 < number < Decimal("1e14")
            or number.as_tuple().exponent < -64):
        raise ValueError("Candle Decimal must be positive, finite and bounded")
    # format(..., 'f') is exact even if the current decimal context is smaller
    # than the supplier's precision. Avoid normalize(), which can round.
    return format(number, "f").rstrip("0").rstrip(".") if number.as_tuple().exponent < 0 else format(number, "f")


class CandleSpec(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    account_scope: StrictStr = Field(pattern=r"^sha256:[a-f0-9]{64}$")
    provider_symbol: StrictStr = Field(pattern=r"^[A-Z0-9]+(?:_[A-Z0-9]+)+$", max_length=64)
    granularity: Literal["M1", "M5", "M15", "M30", "H1", "H4", "D", "W", "M"] = "M1"
    parameters: OandaParameters = Field(default_factory=OandaParameters)
    units: StrictStr = "1"

    @field_validator("units")
    @classmethod
    def canonical_units(cls, value):
        return decimal_text(value)

    @property
    def identity(self):
        return SourceIdentity(source="oanda", channel="v20", environment="practice",
            account_scope=self.account_scope, provider_symbol=self.provider_symbol,
            basis=BASES[self.parameters.price],
            parameters={"granularity": self.granularity, **self.parameters.model_dump(), "units": self.units})

    @property
    def key(self):
        return self.identity.key

    @property
    def wire(self):
        return f"{self.provider_symbol}:{self.granularity}:{self.parameters.price}"

    @property
    def group_parameters(self):
        return {**self.parameters.model_dump(exclude={"price"}), "units": self.units}

    @property
    def group_key(self):
        return digest([self.account_scope, self.group_parameters])

    @classmethod
    def from_source(cls, identity):
        identity = SourceIdentity.model_validate(identity)
        if (identity.source, identity.channel, identity.environment) != ("oanda", "v20", "practice"):
            raise ValueError("OANDA practice v20 candle identity required")
        values = dict(identity.parameters)
        granularity, units = values.pop("granularity"), values.pop("units", "1")
        parameters = OandaParameters.model_validate(values)
        if BASES[parameters.price] != identity.basis:
            raise ValueError("Candle basis does not match request price")
        return cls(account_scope=identity.account_scope, provider_symbol=identity.provider_symbol,
            granularity=granularity, parameters=parameters, units=units)

    @classmethod
    def from_dataset(cls, identity):
        from .source_registry import collection_identity

        return cls.from_source(collection_identity(identity))

    @classmethod
    def from_provider_metadata(cls, metadata, timeframe):
        """Build a native-period request identity from provider cache metadata.

        Provider datasets are keyed by their full native configuration (period,
        side, smoothing and alignment).  Keeping this conversion next to the
        REST wire contract prevents a native H1/D1 subscription from silently
        falling back to the composite M1/BID identity.
        """
        from .native_series import OandaParameters
        from .provider_chart import OANDA_FRAMES

        if metadata.get("source") != "oanda" or timeframe not in OANDA_FRAMES:
            raise ValueError("OANDA native provider metadata required")
        native = OandaParameters.model_validate(metadata.get("native_parameters", {}))
        scope = metadata.get("native_period_identity", {}).get("account_scope")
        if not scope:
            scope = metadata.get("account_scope")
        if not isinstance(scope, str):
            account = metadata.get("account_id")
            if not isinstance(account, str):
                from .history_catalog import account_scope

                scope = account_scope()
            else:
                scope = "sha256:" + hashlib.sha256(account.encode()).hexdigest()
        return cls(account_scope=scope, provider_symbol=metadata["symbol"],
                   granularity=OANDA_FRAMES[timeframe], parameters=native, units="1")


class RestCandle(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    start: StrictInt = Field(ge=0)
    end: StrictInt = Field(gt=0)
    open: StrictStr
    high: StrictStr
    low: StrictStr
    close: StrictStr
    volume: StrictStr | None
    complete: bool = Field(strict=True)

    @field_validator("open", "high", "low", "close")
    @classmethod
    def canonical_price(cls, value):
        return decimal_text(value)

    @model_validator(mode="after")
    def valid_candle(self):
        from .domain import Candle
        from .storage import instant

        Candle(instant(self.start), instant(self.end),
            *(Decimal(getattr(self, name)) for name in ("open", "high", "low", "close")),
            complete=self.complete, volume=quantity(self.volume, tick=True))
        return self


class SeriesSnapshot(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    spec: CandleSpec
    result: RequestResult
    candles: tuple[RestCandle, ...] = Field(default=(), max_length=2)

    @model_validator(mode="after")
    def valid_series(self):
        if bool(self.candles) != (self.result.status == "data"):
            raise ValueError("Only data snapshots contain candles")
        previous = -1
        for candle in self.candles:
            if candle.start <= previous:
                raise ValueError("Latest candles must increase without duplicates")
            if candle.start % 60000 or candle.end != interval_end(candle.start,
                    FRAMES[self.spec.granularity], self.spec.parameters.model_dump()):
                raise ValueError("Candle interval does not match its native specification")
            previous = candle.start
        return self

    @property
    def content_key(self):
        return digest([self.spec.key, [row.model_dump() for row in self.candles]])


class CloseObservation(BaseModel):
    """Receive time means a candle snapshot observation, never a tick time."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    method: Literal["candle_close_sample"] = "candle_close_sample"
    acquisition_mode: Literal["rest_batch"] = "rest_batch"
    protocol_version: Literal[1] = 1
    spec: CandleSpec
    candle: RestCandle
    generation: StrictInt = Field(gt=0)
    sequence: StrictInt = Field(gt=0)
    demand_revision: StrictStr = Field(min_length=1, max_length=128)
    requested_at: StrictInt = Field(ge=0)
    received_at: StrictInt = Field(ge=0)
    committed_at: StrictInt = Field(ge=0)
    recovery: Literal["pending", "ready"]
    interval_ms: StrictInt | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def valid_observation(self):
        if (self.spec.granularity != "M1" or self.candle.complete
                or not self.requested_at <= self.received_at <= self.committed_at
                or not self.candle.start <= self.received_at <= self.committed_at < self.candle.end):
            raise ValueError("Current close requires a current incomplete M1 snapshot")
        return self

    @property
    def snapshot_id(self):
        return digest(self.model_dump(mode="json"))

    @property
    def close(self):
        return self.candle.close


class LatestBatch(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")

    acquisition_mode: Literal["rest_batch"] = "rest_batch"
    protocol_version: Literal[1] = 1
    generation: StrictInt = Field(gt=0)
    sequence: StrictInt = Field(gt=0)
    demand_revision: StrictStr = Field(min_length=1, max_length=128)
    requested_at: StrictInt = Field(ge=0)
    received_at: StrictInt = Field(ge=0)
    result: RequestResult
    series: tuple[SeriesSnapshot, ...] = Field(min_length=1, max_length=MAX_SPECIFICATIONS)

    @model_validator(mode="after")
    def valid_batch(self):
        if self.received_at < self.requested_at:
            raise ValueError("Candle request clock moved backwards")
        if len({row.spec.key for row in self.series}) != len(self.series):
            raise ValueError("Duplicate candle specification")
        if len({row.spec.group_key for row in self.series}) != 1:
            raise ValueError("A batch must share one account and request parameter group")
        for series in self.series:
            if not self.result.successful and (series.result != self.result or series.candles):
                raise ValueError("Failed batch cannot contain successful series")
            if any(row.start > self.received_at or row.complete and row.end > self.received_at
                   for row in series.candles):
                raise ValueError("Candle confirmation cannot precede its interval end")
        return self

    def current_observation(self, spec, *, committed_at, recovery, previous=None, max_age_ms=15000):
        series = next((row for row in self.series if row.spec == spec), None)
        if (not series or not series.result.successful
                or not 0 <= committed_at - self.received_at <= max_age_ms):
            return None
        candle = next((row for row in series.candles if not row.complete
                       and row.start <= self.received_at <= committed_at < row.end), None)
        if candle is None or spec.granularity != "M1":
            return None
        interval = None
        if (previous is not None and previous.spec == spec and previous.generation == self.generation
                and previous.demand_revision == self.demand_revision
                and previous.sequence < self.sequence and previous.received_at < self.received_at):
            interval = self.received_at - previous.received_at
        return CloseObservation(spec=spec, candle=candle, generation=self.generation, sequence=self.sequence,
            demand_revision=self.demand_revision, requested_at=self.requested_at, received_at=self.received_at,
            committed_at=committed_at, recovery=recovery, interval_ms=interval)

    def confirmed_minutes(self, identity):
        """One bounded observation per minute; missing minutes remain unknown."""
        identity = DatasetIdentity.model_validate(identity)
        spec = CandleSpec.from_dataset(identity)
        series = next((row for row in self.series if row.spec == spec), None)
        if not series or not series.result.successful:
            return ()
        return tuple(CandleBatch(identity=identity, window_start=row.start, window_end=row.end,
            checkpoint=row.end, observed_at=self.received_at, result=RequestResult(status="data"),
            volume_kind="price_count", volume_unit="quotes",
            rows=(MinuteRow(timestamp=row.start, **row.model_dump(exclude={"start", "end"})),))
            for row in series.candles if row.complete)


def specifications(values):
    specs = tuple(sorted({value.key: value for value in values}.values(), key=lambda value: value.key))
    if not specs or len(specs) > MAX_SPECIFICATIONS:
        raise ValueError("Use between 1 and 12 distinct candle specifications")
    if len({value.group_key for value in specs}) != 1:
        raise ValueError("Separate candle requests by account, alignment, smoothing and units")
    return specs


def parse_series(raw, spec, received_at):
    if not isinstance(raw, list) or len(raw) > 2:
        raise ValueError("Latest candle list must contain at most two candles")
    rows = []
    for candle in raw:
        if not isinstance(candle, dict):
            raise ValueError("Invalid latest candle")
        start = timestamp(candle["time"])
        end = interval_end(start, FRAMES[spec.granularity], spec.parameters.model_dump())
        if start > received_at or candle["complete"] is True and end > received_at:
            raise ValueError("Future candle or premature supplier confirmation")
        volume = candle.get("volume")
        if volume is not None and (type(volume) is not int or volume < 0):
            raise ValueError("Supplier volume must be an integer quote count")
        side = candle[SIDES[spec.parameters.price]]
        rows.append(RestCandle(start=start, end=end, complete=candle["complete"],
            volume=str(volume) if volume is not None else None,
            **{name: side[key] for name, key in (("open", "o"), ("high", "h"), ("low", "l"), ("close", "c"))}))
    return SeriesSnapshot(spec=spec, candles=tuple(rows),
        result=RequestResult(status="data" if rows else "empty_success"))


def normalize_latest(payload, specs, *, generation, sequence, demand_revision, requested_at, received_at):
    specs = specifications(specs)
    if not isinstance(payload, dict) or not isinstance(payload.get("latestCandles"), list):
        raise ValueError("Invalid latest candle envelope")
    # The response identifies symbol/period; price components identify its side.
    # Missing or malformed requested series are isolated, while an unrequested
    # identity or duplicate group makes the entire envelope untrustworthy.
    groups = {}
    expected = {(spec.provider_symbol, spec.granularity) for spec in specs}
    for group in payload["latestCandles"]:
        if not isinstance(group, dict):
            raise ValueError("Invalid latest candle group")
        key = (group.get("instrument"), group.get("granularity"))
        if key not in expected:
            raise ValueError("Unexpected latest candle identity")
        # The supplier may emit one response per price-side specification or
        # combine sides in one group. Route by the returned OHLC component.
        groups.setdefault(key, []).append(group.get("candles"))
    series = []
    for spec in specs:
        try:
            candidates = groups[(spec.provider_symbol, spec.granularity)]
            matching = [raw for raw in candidates if isinstance(raw, list) and raw
                        and all(isinstance(candle, dict) and SIDES[spec.parameters.price] in candle
                                for candle in raw)]
            if len(matching) > 1 or len(candidates) > 1 and any(not raw for raw in candidates):
                raise ValueError("Duplicate or ambiguous latest candle identity")
            raw = matching[0] if matching else candidates[0] if len(candidates) == 1 else None
            series.append(parse_series(raw, spec, received_at))
        except (ValueError, KeyError, TypeError, OverflowError):
            series.append(SeriesSnapshot(spec=spec, result=RequestResult(status="invalid_payload")))
    return LatestBatch(generation=generation, sequence=sequence, demand_revision=demand_revision,
        requested_at=requested_at, received_at=received_at, result=RequestResult(status="data"
            if any(row.candles for row in series) else "empty_success"), series=tuple(series))


class OandaRestBatch(OandaPractice):
    def latest(self, specs, *, generation, sequence, demand_revision, deadline=None, cancelled=None):
        specs = specifications(specs)
        scope = "sha256:" + hashlib.sha256(self.account_id.encode()).hexdigest()
        if specs[0].account_scope != scope:
            raise ValueError("OANDA batch account scope mismatch")
        requested_at = self.clock()
        # Bound the whole operation, including slot wait and socket reads.
        deadline = deadline if deadline is not None else time.monotonic() + 15
        trace, response = TransportTrace(), None
        try:
            with request_slot("oanda", deadline=deadline, cancelled=cancelled):
                if cancelled and cancelled():
                    raise TimeoutError("Candle demand was superseded")
                if deadline is not None and time.monotonic() >= deadline:
                    raise TimeoutError("Candle request deadline expired")
                params = {**specs[0].group_parameters,
                    "smooth": str(specs[0].parameters.smooth).lower(),
                    "candleSpecifications": ",".join(sorted(spec.wire for spec in specs))}
                trace.phase, trace.route = "request", "upstream"
                with request_deadline(deadline):
                    response = self.rest_get(
                        f"https://api-fxpractice.oanda.com/v3/accounts/{self.account_id}/candles/latest",
                        headers=self.headers, params=params, extensions={"trace": trace})
            response.raise_for_status()
            return normalize_latest(response.json(), specs, generation=generation, sequence=sequence,
                demand_revision=demand_revision, requested_at=requested_at, received_at=self.clock())
        except (httpx.HTTPError, TimeoutError, ValueError, KeyError, TypeError, OverflowError) as error:
            trace.rest_failed("candles_latest", error, response)
            received_at = self.clock()
            result = failed_request(error, observed_at=received_at)
            if result.status == "rate_limited":
                cooldown("oanda", retry_seconds=max(1, (result.retry_at - received_at) / 1000)
                         if result.retry_at else None)
            return LatestBatch(generation=generation, sequence=sequence, demand_revision=demand_revision,
                requested_at=requested_at, received_at=received_at, result=result,
                series=tuple(SeriesSnapshot(spec=spec, result=result) for spec in specs))

    def page(self, identity, start, end, *, deadline=None, cancelled=None):
        """Fetch a bounded complete-M1 confirmation window for the owner.

        The latest endpoint is the normal cadence path. This endpoint proves
        only the requested half-open interval and never turns an omitted
        middle minute into coverage.
        """
        source = DatasetIdentity.model_validate(identity)
        spec = CandleSpec.from_dataset(source)
        if spec.granularity != "M1":
            raise ValueError("REST confirmation requires an M1 dataset identity")
        if not 0 <= start < end or end - start > 4000 * 60000 or start % 60000 or end % 60000:
            raise ValueError("Use at most 4000 UTC M1 candles per request")
        scope = "sha256:" + hashlib.sha256(self.account_id.encode()).hexdigest()
        if source.account_scope != scope:
            raise ValueError("OANDA account scope mismatch")
        deadline = deadline if deadline is not None else time.monotonic() + 15
        trace, response = TransportTrace(), None
        try:
            with request_slot("oanda", deadline=deadline, cancelled=cancelled):
                if cancelled and cancelled():
                    raise TimeoutError("Candle confirmation was superseded")
                with request_deadline(deadline):
                    response = self.rest_get(
                        f"https://api-fxpractice.oanda.com/v3/accounts/{self.account_id}"
                        f"/instruments/{spec.provider_symbol}/candles",
                        headers=self.headers,
                        params={
                            "granularity": "M1",
                            "price": spec.parameters.price,
                            "smooth": str(spec.parameters.smooth).lower(),
                            "from": str(Decimal(start) / 1000),
                            "to": str(Decimal(end) / 1000),
                        },
                        extensions={"trace": trace},
                    )
            response.raise_for_status()
            raw = response.json()
            if raw.get("instrument", spec.provider_symbol) != spec.provider_symbol:
                raise ValueError("OANDA response instrument mismatch")
            if raw.get("granularity", "M1") != "M1" or not isinstance(raw.get("candles"), list):
                raise ValueError("Invalid OANDA candle response")
            observed = self.clock()
            rows = []
            side = SIDES[spec.parameters.price]
            for candle in raw["candles"]:
                if not isinstance(candle, dict) or type(candle.get("complete")) is not bool:
                    raise ValueError("Invalid OANDA complete flag")
                at = timestamp(candle["time"])
                if not start <= at < end:
                    raise ValueError("OANDA M1 outside requested half-open window")
                if not candle["complete"] or at + 60000 > observed:
                    continue
                prices = candle.get(side)
                if not isinstance(prices, dict):
                    raise ValueError("OANDA candle price side missing")
                volume = candle.get("volume")
                if volume is not None and (type(volume) is not int or volume < 0):
                    raise ValueError("Supplier volume must be an integer quote count")
                rows.append(MinuteRow(timestamp=at, complete=True,
                    **{name: prices[key] for name, key in (("open", "o"), ("high", "h"),
                                                           ("low", "l"), ("close", "c"))},
                    volume=str(volume) if volume is not None else None))
            rows.sort(key=lambda row: row.timestamp)
            return CandleBatch(identity=source, window_start=start, window_end=end,
                observed_at=observed, rows=tuple(rows),
                volume_kind="price_count", volume_unit="quotes",
                result=RequestResult(status="data" if rows else "empty_success"),
                checkpoint=end)
        except (httpx.HTTPError, TimeoutError, ValueError, KeyError, TypeError, OverflowError) as error:
            trace.rest_failed("candles", error, response)
            observed = self.clock()
            result = failed_request(error, observed_at=observed)
            if result.status == "rate_limited":
                cooldown("oanda", retry_seconds=max(1, (result.retry_at - observed) / 1000)
                         if result.retry_at else None)
            return CandleBatch(identity=source, window_start=start, window_end=end,
                observed_at=observed, result=result,
                volume_kind="price_count", volume_unit="quotes", checkpoint=start)

    def validate_candle_access(self, specs):
        """Account catalog plus real candles, without pricing or streaming."""
        specs = specifications(specs)
        if specs[0].account_scope != "sha256:" + hashlib.sha256(self.account_id.encode()).hexdigest():
            raise ValueError("OANDA batch account scope mismatch")
        summary = self._account_json("summary")
        if summary.get("account", {}).get("id") != self.account_id:
            raise ValueError("OANDA configured account summary mismatch")
        catalog = self.catalog()
        if not {spec.provider_symbol for spec in specs} <= {row["name"] for row in catalog}:
            raise ValueError("OANDA configured account instruments mismatch")
        batch = self.latest(specs, generation=1, sequence=1, demand_revision="auth-probe")
        if not batch.result.successful or any(not row.result.successful for row in batch.series):
            from .market_contracts import MarketRequestError

            failure = next((row.result for row in batch.series if not row.result.successful), batch.result)
            raise MarketRequestError(failure)
        return catalog
