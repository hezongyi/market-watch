"""One bounded Spot M1 request, with exact prices and base-asset volume."""

import re
import time

import httpx

from .market_contracts import CandleBatch, MinuteRow, RequestResult, failed_request
from .provider_transport import binance_get, pooled_client
from .storage import now_ms


class BinanceHistory:
    def __init__(self, *, client=None, clock=None):
        self.client = client
        self.clock = clock or now_ms

    def close(self):
        pass  # Caller owns an injected client; shared transport owns its pool.

    def page(self, identity, start, end):
        if (identity.source, identity.channel, identity.environment,
                identity.account_scope, identity.basis) != ("binance", "rest", "public", "public", "last"):
            raise ValueError("Binance public Spot last-price identity required")
        if not re.fullmatch(r"[A-Z0-9]{2,64}", identity.provider_symbol):
            raise ValueError("请选择准确的 Binance 现货代码")
        if not 0 <= start < end or end - start > 1000 * 60000 or start % 60000 or end % 60000:
            raise ValueError("Use at most 1000 UTC M1 candles per request")
        observed = self.clock()
        rows, checkpoint = [], start
        try:
            response = binance_get(self.client or pooled_client("binance"),
                "https://data-api.binance.vision/api/v3/klines", params={
                    "symbol": identity.provider_symbol, "interval": "1m",
                    "startTime": start, "endTime": end - 1, "limit": 1000},
                deadline=time.monotonic() + 20)
            payload = response.json()
            observed = self.clock()
            if not isinstance(payload, list) or len(payload) > 1000:
                raise ValueError("Invalid Binance snapshot")
            for item in payload:
                at = item[0]
                if type(at) is not int or not start <= at < end or item[6] != at + 59999:
                    raise ValueError("Binance M1 outside requested window or duration")
                if at + 60000 > observed - 5000:
                    continue
                rows.append(MinuteRow(timestamp=at, complete=True,
                    **dict(zip(("open", "high", "low", "close"), item[1:5])), volume=item[5]))
            checkpoint = end
            result = RequestResult(status="data" if rows else "empty_success")
            return CandleBatch(identity=identity, window_start=start, window_end=end,
                observed_at=observed, rows=tuple(rows), result=result,
                volume_kind="base", volume_unit="source_base", checkpoint=checkpoint)
        except (httpx.HTTPError, TimeoutError, ValueError, KeyError, TypeError, IndexError) as error:
            return CandleBatch(identity=identity, window_start=start, window_end=end,
                observed_at=observed, result=failed_request(error, observed_at=observed),
                volume_kind="base", volume_unit="source_base", checkpoint=start)
