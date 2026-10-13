"""Read-only OANDA practice stream and confirmed M1 adapter."""

import codecs
import json
import logging
import time
from datetime import datetime
from decimal import Decimal, InvalidOperation

import httpx

from .market_contracts import CandleBatch, MinuteRow, QuoteEvent, RequestResult, failed_request
from .market_resources import cooldown, request_slot
from .provider_transport import (
    activity,
    client_for_key,
    discard_client,
    retire_client,
    retryable_network_error,
)

log = logging.getLogger(__name__)


class TransportTrace:
    """Translate HTTPcore events to bounded diagnostics, discarding metadata."""

    def __init__(self):
        self.started = time.monotonic()
        self.phase, self.failed_phase, self.route = "request_slot", None, "local"

    def __call__(self, name, info):
        phases = {"connect_tcp": "connect", "start_tls": "tls",
                  "send_request_headers": "send_headers", "send_request_body": "send_body",
                  "receive_response_headers": "receive_headers", "receive_response_body": "receive_body"}
        parts = name.split(".")
        if len(parts) != 3 or parts[0] not in ("connection", "proxy", "http11", "http2"):
            return
        if parts[1] == "send_request_headers" and parts[2] == "started":
            method = getattr(info.get("request"), "method", None)
            self.route = "proxy_connect" if method == b"CONNECT" else "upstream"
        elif parts[0] == "proxy" and parts[1] == "start_tls":
            self.route = "proxy_tls"
        if parts[1] in phases:
            if parts[2] == "started":
                self.phase = phases[parts[1]]
            elif parts[2] == "failed":
                self.failed_phase = phases[parts[1]]

    def failure(self, error, response):
        phase, route = self.failed_phase or self.phase, self.route
        if isinstance(error, httpx.HTTPStatusError):
            phase, response = "http_status", error.response
        elif isinstance(error, httpx.PoolTimeout):
            phase, route = "pool", "pool"
        elif isinstance(error, (ValueError, KeyError, TypeError)):
            phase = "payload"
        content_type = response.headers.get("content-type", "") if response is not None else ""
        body_kind = ("json" if content_type.startswith("application/json") else
                     "html" if content_type.startswith("text/html") else "other")
        return (phase, route, type(error).__name__,
                response.status_code if response is not None else "-", body_kind,
                round((time.monotonic() - self.started) * 1000))

    def rest_failed(self, operation, error, response):
        log.warning("oanda_rest_failed operation=%s phase=%s route=%s type=%s http_status=%s "
                    "body_kind=%s elapsed_ms=%s", operation, *self.failure(error, response))


def timestamp(value):
    if not isinstance(value, str):
        raise ValueError("Source timestamp must be a string")
    try:
        seconds = Decimal(value)
        if seconds.is_finite() and seconds >= 0:
            return int(seconds * 1000)
    except InvalidOperation:
        pass
    instant = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if instant.tzinfo is None:
        raise ValueError("OANDA timestamp must carry UTC timezone")
    return int(instant.timestamp() * 1000)


class NDJSONDecoder:
    """Incremental UTF-8, bounded per-record buffering across network chunks."""

    def __init__(self, max_bytes=262144):
        self.decoder = codecs.getincrementaldecoder("utf-8")(errors="strict")
        self.buffer = ""
        self.max_bytes = max_bytes

    def feed(self, chunk):
        self.buffer += self.decoder.decode(chunk)
        lines = self.buffer.split("\n")
        self.buffer = lines.pop()
        if len(self.buffer.encode()) > self.max_bytes:
            raise ValueError("OANDA record exceeds buffer limit")
        messages = []
        for line in lines:
            if not line.strip():
                continue
            if len(line.encode()) > self.max_bytes:
                raise ValueError("OANDA record exceeds buffer limit")
            value = json.loads(line)
            if not isinstance(value, dict):
                raise ValueError("OANDA record must be an object")
            messages.append(value)
        return messages

    def finish(self):
        self.buffer += self.decoder.decode(b"", final=True)
        if self.buffer.strip():
            raise ValueError("OANDA stream ended within an unfinished record")


def price_event(raw, identities, *, epoch, sequence, received_at):
    if raw.get("type") == "HEARTBEAT":
        return {"type": "heartbeat", "source_time": timestamp(raw["time"]),
                "received_at": received_at, "connection_epoch": epoch}
    if raw.get("type") != "PRICE" or raw.get("instrument") not in identities:
        raise ValueError("Unexpected OANDA pricing record")

    def side(name):
        levels = raw.get(name)
        if not isinstance(levels, list):
            raise ValueError("Invalid OANDA quote levels")
        return levels[0]["price"] if levels else None

    return QuoteEvent(identity=identities[raw["instrument"]], bid=side("bids"), ask=side("asks"),
        source_time=timestamp(raw["time"]), received_at=received_at, tradeable=raw["tradeable"],
        connection_epoch=epoch, sequence=sequence)


class OandaPractice:
    def __init__(self, *, token, account_id, proxy=None, rest_client=None, stream_client=None,
                 clock=None):
        if not token or not account_id:
            raise ValueError("OANDA practice backend credentials are required")
        self.token, self.account_id = token, account_id
        self.proxy = proxy or None
        self.rest = rest_client or client_for_key(('oanda', proxy or '', 'pricing'))
        self.stream_client = stream_client
        self.owns_rest = rest_client is None
        self.owns_stream = stream_client is None
        self.clock = clock or (lambda: int(time.time() * 1000))

    def close(self):
        if self.owns_rest:
            retire_client(self.rest)
        if self.owns_stream and self.stream_client is not None:
            self.stream_client.close()

    @property
    def headers(self):
        return {"Authorization": "Bearer " + self.token, "Accept-Datetime-Format": "UNIX"}

    def rest_get(self, url, **kwargs):
        # Each operation redirects old handles after failure; concurrent readers
        # finish their own generation before its pool is closed.
        with activity(self.rest) as client:
            try:
                if self.owns_rest:
                    kwargs['timeout'] = httpx.Timeout(15, connect=5)
                return client.get(url, **kwargs)
            except httpx.TransportError as error:
                if self.owns_rest and retryable_network_error(error):
                    discard_client(client)
                raise

    def catalog(self):
        trace, response = TransportTrace(), None
        try:
            with request_slot("oanda"):
                trace.phase, trace.route = "request", "upstream"
                response = self.rest_get(
                    "https://api-fxpractice.oanda.com/v3/accounts/" + self.account_id + "/instruments",
                    headers=self.headers, extensions={"trace": trace})
            response.raise_for_status()
            items = response.json()["instruments"]
            if not isinstance(items, list):
                raise ValueError("Invalid OANDA account catalog")
            return items
        except (httpx.HTTPError, TimeoutError, ValueError, KeyError, TypeError) as error:
            trace.rest_failed("catalog", error, response)
            raise

    def _account_json(self, endpoint, *, params=None):
        with request_slot('oanda'):
            response = self.rest_get(
                'https://api-fxpractice.oanda.com/v3/accounts/' + self.account_id + '/' + endpoint,
                headers=self.headers, params=params)
        response.raise_for_status()
        return response.json()

    def validate_access(self, symbols):
        """A closed-market snapshot proves auth only, never quote freshness."""
        import hashlib

        from .market_contracts import DatasetIdentity

        symbols = sorted(set(symbols))
        if not symbols or len(symbols) > 200:
            raise ValueError('A bounded account pricing probe requires instruments')
        summary = self._account_json('summary')
        if summary.get('account', {}).get('id') != self.account_id:
            raise ValueError('OANDA configured account summary mismatch')
        catalog = self.catalog()
        if not set(symbols) <= {row['name'] for row in catalog}:
            raise ValueError('OANDA configured account instruments mismatch')
        payload = self._account_json('pricing', params={'instruments': ','.join(symbols)})
        prices = payload.get('prices')
        if not isinstance(prices, list):
            raise ValueError('Invalid OANDA pricing probe')
        scope = 'sha256:' + hashlib.sha256(self.account_id.encode()).hexdigest()
        identities = {symbol: DatasetIdentity(source='oanda', channel='v20', environment='practice',
            account_scope=scope, provider_symbol=symbol, basis='bid', calendar_version='auth-probe')
            for symbol in symbols}
        seen = set()
        for raw in prices:
            if not isinstance(raw, dict) or raw.get('instrument') not in identities or raw['instrument'] in seen:
                raise ValueError('OANDA pricing probe instrument mismatch')
            event = price_event(raw, identities, epoch=1, sequence=1, received_at=self.clock())
            if not isinstance(event, QuoteEvent):
                raise ValueError('OANDA pricing probe requires prices')
            seen.add(raw['instrument'])
        if seen != set(symbols):
            raise ValueError('OANDA pricing probe is incomplete')
        return catalog

    def page(self, identity, start, end):
        if (identity.source, identity.environment, identity.channel, identity.basis) != (
                "oanda", "practice", "v20", "bid"):
            raise ValueError("OANDA practice BID identity required")
        import hashlib

        if identity.account_scope != "sha256:" + hashlib.sha256(self.account_id.encode()).hexdigest():
            raise ValueError("OANDA account scope mismatch")
        if not 0 <= start < end or end - start > 4000 * 60000 or start % 60000 or end % 60000:
            raise ValueError("Use at most 4000 UTC M1 candles per request")
        trace, response = TransportTrace(), None
        try:
            with request_slot("oanda"):
                trace.phase, trace.route = "request", "upstream"
                response = self.rest_get(
                    f"https://api-fxpractice.oanda.com/v3/accounts/{self.account_id}"
                    f"/instruments/{identity.provider_symbol}/candles",
                    headers=self.headers, params={"granularity": "M1", "price": "B",
                        "smooth": "false", "from": str(Decimal(start) / 1000),
                        "to": str(Decimal(end) / 1000)}, extensions={"trace": trace})
            response.raise_for_status()
            raw = response.json()
            if raw.get("instrument", identity.provider_symbol) != identity.provider_symbol:
                raise ValueError("OANDA response instrument mismatch")
            if raw.get("granularity", "M1") != "M1" or not isinstance(raw["candles"], list):
                raise ValueError("Invalid OANDA candle response")
            rows = []
            observed = self.clock()
            for candle in raw["candles"]:
                if type(candle["complete"]) is not bool:
                    raise ValueError("Invalid OANDA complete flag")
                at = timestamp(candle["time"])
                if not start <= at < end:
                    raise ValueError("OANDA M1 outside requested half-open window")
                if not candle["complete"] or at + 60000 > observed - 5000:
                    continue
                prices = candle["bid"]
                rows.append(MinuteRow(timestamp=at, complete=True,
                    **{name: prices[key] for name, key in
                       (("open", "o"), ("high", "h"), ("low", "l"), ("close", "c"))},
                    volume=str(candle["volume"]) if candle.get("volume") is not None else None))
            return CandleBatch(identity=identity, window_start=start, window_end=end,
                observed_at=observed, rows=tuple(rows), volume_kind="price_count", volume_unit="quotes",
                result=RequestResult(status="data" if rows else "empty_success"), checkpoint=end)
        except (httpx.HTTPError, TimeoutError, ValueError, KeyError, TypeError) as error:
            trace.rest_failed("candles", error, response)
            observed = self.clock()
            result = failed_request(error, observed_at=observed)
            if result.status == "rate_limited":
                seconds = max(1, (result.retry_at - observed) / 1000) if result.retry_at else None
                cooldown("oanda", retry_seconds=seconds)
            return CandleBatch(identity=identity, window_start=start, window_end=end,
                observed_at=observed, result=result, volume_kind="price_count", volume_unit="quotes",
                checkpoint=start)

    def confirm_daily_price(self, source, start, end):
        """Independent complete D1 OHLC, bound to the same practice account."""
        import hashlib

        from .composite_price_confirmation import CONTRACT
        from .native_series import OandaParameters, interval_end, session_start

        if (source.source, source.channel, source.environment, source.basis, source.account_scope) != (
                "oanda", "v20", "practice", "bid",
                "sha256:" + hashlib.sha256(self.account_id.encode()).hexdigest()):
            raise ValueError("Native price confirmation requires the same OANDA account and BID identity")
        parameters = dict(source.parameters)
        if parameters.pop("granularity", None) != "D":
            raise ValueError("Only native daily price confirmation is supported")
        native = OandaParameters.model_validate(parameters).model_dump()
        if (native["price"] != "B" or native["smooth"] or session_start(start, native) != start
                or interval_end(start, "D1", native) != end):
            raise ValueError("Native price confirmation alignment mismatch")
        if not 0 <= start < end <= self.clock():
            return None
        with request_slot("oanda"):
            response = self.rest_get(
                f"https://api-fxpractice.oanda.com/v3/accounts/{self.account_id}"
                f"/instruments/{source.provider_symbol}/candles", headers=self.headers,
                params={"granularity": "D", **native, "smooth": "false",
                        "from": str(Decimal(start) / 1000), "to": str(Decimal(end) / 1000)})
        response.raise_for_status()
        raw = response.json()
        if raw.get("instrument") != source.provider_symbol or raw.get("granularity") != "D":
            raise ValueError("Native daily response identity mismatch")
        if not isinstance(raw.get("candles"), list):
            raise ValueError("Invalid native daily candles")
        matches = [candle for candle in raw["candles"] if timestamp(candle["time"]) == start]
        if len(matches) > 1:
            raise ValueError("Duplicate native daily candles")
        if not matches:
            return None
        candle = matches[0]
        if type(candle["complete"]) is not bool:
            raise ValueError("Invalid native daily complete flag")
        if not candle["complete"]:
            return None
        prices = candle["bid"]
        row = MinuteRow(timestamp=start, complete=True,
            **{name: prices[key] for name, key in
               (("open", "o"), ("high", "h"), ("low", "l"), ("close", "c"))})
        return {"contract": CONTRACT, "source_id": source.key, "start": start, "end": end,
                "complete": True, "observed_at": self.clock(),
                **row.model_dump(include={"open", "high", "low", "close"})}

    def stream(self, identities, *, epoch, stopped=None):
        decoder = NDJSONDecoder()
        sequence = 0
        trace = TransportTrace()
        trace.phase, trace.route = "request", "upstream"
        last_record = None
        response = None
        # A failed proxy TLS upgrade can leave HTTPcore's CONNECT connection
        # ACTIVE, occupying the only pool slot. Each owned stream attempt has
        # its own pool, closed on every exit, including partial iteration.
        client = self.stream_client
        if client is None:
            client = httpx.Client(proxy=self.proxy, trust_env=False,
                timeout=httpx.Timeout(15, connect=5), limits=httpx.Limits(max_connections=1))
            self.stream_client = client

        try:
            with client.stream("GET",
                    f"https://stream-fxpractice.oanda.com/v3/accounts/{self.account_id}/pricing/stream",
                    headers=self.headers, params={"instruments": ",".join(sorted(identities)),
                                                  "snapshot": "true"},
                    extensions={"trace": trace}) as response:
                response.raise_for_status()
                for chunk in response.iter_bytes():
                    if stopped and stopped():
                        return
                    for raw in decoder.feed(chunk):
                        sequence += 1
                        last_record = time.monotonic()
                        yield price_event(raw, identities, epoch=epoch, sequence=sequence,
                                          received_at=self.clock())
                decoder.finish()
        except httpx.HTTPError as error:
            phase, route, kind, status, body_kind, elapsed = trace.failure(error, response)
            log.warning("pricing_transport_failed phase=%s route=%s type=%s epoch=%s http_status=%s "
                        "body_kind=%s elapsed_ms=%s since_record_ms=%s records=%s",
                        phase, route, kind, epoch, status, body_kind, elapsed,
                        round((time.monotonic() - last_record) * 1000) if last_record is not None else "-", sequence)
            raise
        finally:
            if self.owns_stream:
                client.close()
                self.stream_client = None
