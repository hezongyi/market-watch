"""Bounded SDK pages with explicit transport failures and restart checkpoints.

The pinned SDK constructs/decodes requests and drives its row iterator. A private
module instance binds transport per adapter so other SDK callers are unaffected.
One page crosses the interface at a time; the transport stops the SDK before its
next network request. Empty pages terminate successfully instead of entering the
SDK's empty-page indexing/retry path. No unbounded DataFrame is accumulated.
"""

import importlib.metadata
import importlib.util
import json
import logging
import time
from datetime import UTC, datetime
from decimal import Decimal
from types import SimpleNamespace

import httpx

from .market_contracts import CandleBatch, MinuteRow, RequestResult, failed_request
from .market_resources import request_slot


class _PageFinished(BaseException):
    pass


class _RequestFailed(BaseException):
    def __init__(self, error):
        self.error = error


class DukascopyHistory:
    """Read one restartable BID M1 page, at most 5,000 source rows."""

    def __init__(self, *, proxy=None, client=None, clock=None, page_size=5000):
        if importlib.metadata.version("dukascopy-python") != "4.0.1":
            raise RuntimeError("Dukascopy SDK version must be 4.0.1")
        if not 1 <= page_size <= 5000:
            raise ValueError("Page size must be between 1 and 5000")
        spec = importlib.util.find_spec("dukascopy_python")
        isolated = importlib.util.spec_from_file_location("_mw_dukascopy_sdk", spec.origin)
        self.sdk = importlib.util.module_from_spec(isolated)
        isolated.loader.exec_module(self.sdk)
        # Avoid SDK info logs containing per-page dates and tracebacks.
        self.sdk.logging = SimpleNamespace(info=lambda *args: None)
        self.client = client or httpx.Client(proxy=proxy or None, trust_env=False,
                                             timeout=httpx.Timeout(20, connect=5))
        self.owns_client = client is None
        self.clock = clock or (lambda: int(time.time() * 1000))
        self.page_size = page_size

    def close(self):
        if self.owns_client:
            self.client.close()

    def page(self, identity, start, end):
        if (identity.source, identity.channel, identity.environment, identity.basis) != (
                "dukascopy", "python", "historical", "bid"):
            raise ValueError("Dukascopy historical BID identity required")
        if not 0 <= start < end or end - start > 31 * 86400000 or start % 60000 or end % 60000:
            raise ValueError("Use a bounded UTC whole-minute window")
        calls = 0
        source_page = []

        def get(url, **kwargs):
            nonlocal calls, source_page
            if calls:
                raise _PageFinished()
            calls += 1
            try:
                with request_slot("dukascopy"):
                    response = self.client.get(url, **kwargs)
                response.raise_for_status()
                callback = kwargs["params"]["jsonp"]
                prefix, suffix = callback + "(", ");"
                if not response.text.startswith(prefix) or not response.text.endswith(suffix):
                    raise ValueError("Invalid SDK JSONP response")
                # Decode numbers exactly; hand the identical Decimal rows to SDK.
                source_page = json.loads(response.text[len(prefix):-len(suffix)], parse_float=Decimal)
                if not isinstance(source_page, list) or len(source_page) > self.page_size:
                    raise ValueError("Invalid source page size")
                if not source_page:
                    raise _PageFinished()
                if any(not isinstance(row, list) or len(row) != 6 for row in source_page):
                    raise ValueError("Invalid M1 source row")
                previous = start - 1
                for row in source_page:
                    if type(row[0]) is not int or row[0] <= previous:
                        raise ValueError("Source page is not strictly increasing")
                    previous = row[0]
                # SDK owns JSONP decoding; exact numeric JSON serialization is
                # supplied by an isolated decoder, not a global monkey patch.
                return response
            except _PageFinished:
                raise
            except (httpx.HTTPError, TimeoutError, ValueError, KeyError, TypeError) as error:
                raise _RequestFailed(error) from None

        self.sdk.requests = SimpleNamespace(get=get)
        self.sdk.json = SimpleNamespace(loads=lambda value: json.loads(value, parse_float=Decimal))
        rows = []
        error = None
        try:
            iterator = self.sdk._stream(
                instrument=identity.provider_symbol, interval=self.sdk.INTERVAL_MIN_1,
                offer_side=self.sdk.OFFER_SIDE_BID,
                start=datetime.fromtimestamp(start / 1000, UTC),
                end=datetime.fromtimestamp(end / 1000, UTC), max_retries=0,
                limit=self.page_size, logger=logging.getLogger("market-history-sdk"),
            )
            for raw in iterator:
                if start <= raw[0] < end:
                    rows.append(MinuteRow(timestamp=raw[0],
                        **{name: str(raw[index]) for index, name in
                           enumerate(("open", "high", "low", "close"), start=1)},
                        volume=str(raw[5]) if raw[5] is not None else None, complete=True))
        except _PageFinished:
            pass
        except _RequestFailed as failure:
            error = failure.error
        except (ValueError, KeyError, TypeError, IndexError) as failure:
            error = failure
        observed = self.clock()
        if error is not None:
            return CandleBatch(identity=identity, window_start=start, window_end=end,
                observed_at=observed, result=failed_request(error, observed_at=observed),
                volume_kind="quantity", volume_unit="source_quantity", checkpoint=start)
        # A full page continues after its last minute. Short/empty page records
        # a queried remainder as unknown; it never certifies missing observations.
        checkpoint = (min(end, rows[-1].timestamp + 60000)
                      if len(source_page) == self.page_size and rows else end)
        if checkpoint <= start:
            raise ValueError("SDK page checkpoint did not advance")
        return CandleBatch(identity=identity, window_start=start, window_end=end,
            observed_at=observed, result=RequestResult(status="data" if rows else "empty_success"),
            rows=tuple(rows), volume_kind="quantity", volume_unit="source_quantity",
            checkpoint=checkpoint)
