"""Read-only OANDA practice stream and confirmed M1 adapter."""

import codecs
import json
import time
from datetime import datetime
from decimal import Decimal, InvalidOperation

import httpx

from .market_contracts import CandleBatch, MinuteRow, QuoteEvent, RequestResult, failed_request
from .market_resources import cooldown, request_slot


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
        self.rest = rest_client or httpx.Client(proxy=proxy or None, trust_env=False,
                                                timeout=httpx.Timeout(15, connect=5))
        # Stream never holds a REST request slot or shares its connection pool.
        self.stream_client = stream_client or httpx.Client(proxy=proxy or None, trust_env=False,
            timeout=httpx.Timeout(15, connect=5), limits=httpx.Limits(max_connections=1))
        self.owns_rest = rest_client is None
        self.owns_stream = stream_client is None
        self.clock = clock or (lambda: int(time.time() * 1000))

    def close(self):
        if self.owns_rest:
            self.rest.close()
        if self.owns_stream:
            self.stream_client.close()

    @property
    def headers(self):
        return {"Authorization": "Bearer " + self.token, "Accept-Datetime-Format": "UNIX"}

    def catalog(self):
        with request_slot("oanda"):
            response = self.rest.get(
                "https://api-fxpractice.oanda.com/v3/accounts/" + self.account_id + "/instruments",
                headers=self.headers)
        response.raise_for_status()
        items = response.json()["instruments"]
        if not isinstance(items, list):
            raise ValueError("Invalid OANDA account catalog")
        return items

    def page(self, identity, start, end):
        if (identity.source, identity.environment, identity.channel, identity.basis) != (
                "oanda", "practice", "v20", "bid"):
            raise ValueError("OANDA practice BID identity required")
        import hashlib

        if identity.account_scope != "sha256:" + hashlib.sha256(self.account_id.encode()).hexdigest():
            raise ValueError("OANDA account scope mismatch")
        if not 0 <= start < end or end - start > 4000 * 60000 or start % 60000 or end % 60000:
            raise ValueError("Use at most 4000 UTC M1 candles per request")
        try:
            with request_slot("oanda"):
                response = self.rest.get(
                    f"https://api-fxpractice.oanda.com/v3/accounts/{self.account_id}"
                    f"/instruments/{identity.provider_symbol}/candles",
                    headers=self.headers, params={"granularity": "M1", "price": "B",
                        "smooth": "false", "from": str(Decimal(start) / 1000),
                        "to": str(Decimal(end) / 1000)})
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
            observed = self.clock()
            result = failed_request(error, observed_at=observed)
            if result.status == "rate_limited":
                seconds = max(1, (result.retry_at - observed) / 1000) if result.retry_at else None
                cooldown("oanda", retry_seconds=seconds)
            return CandleBatch(identity=identity, window_start=start, window_end=end,
                observed_at=observed, result=result, volume_kind="price_count", volume_unit="quotes",
                checkpoint=start)

    def stream(self, identities, *, epoch, stopped=None):
        decoder = NDJSONDecoder()
        sequence = 0
        with self.stream_client.stream("GET",
                f"https://stream-fxpractice.oanda.com/v3/accounts/{self.account_id}/pricing/stream",
                headers=self.headers, params={"instruments": ",".join(sorted(identities)),
                                              "snapshot": "true"}) as response:
            response.raise_for_status()
            for chunk in response.iter_bytes():
                if stopped and stopped():
                    return
                for raw in decoder.feed(chunk):
                    sequence += 1
                    yield price_event(raw, identities, epoch=epoch, sequence=sequence,
                                      received_at=self.clock())
            decoder.finish()
