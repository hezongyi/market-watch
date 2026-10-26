"""One disposable SDK request. stdout is only a bounded safe JSON protocol."""

import contextlib
import ctypes
import json
import os
import signal
import sys

ENDPOINTS = {
    "stock_zh_a_hist", "stock_zh_a_hist_min_em", "stock_hk_hist", "stock_hk_hist_min_em",
    "futures_zh_daily_sina", "futures_zh_minute_sina", "stock_info_a_code_name",
    "stock_hk_spot_em", "stock_hk_spot", "futures_display_main_sina", "stock_hk_daily",
    "stock_zh_a_daily", "stock_zh_a_hist_tx",
}


def main():
    # Ubuntu/Linux: terminating a history worker must not orphan a blocked SDK
    # request that still holds network sockets after its source lease expires.
    parent = os.getppid()
    ctypes.CDLL(None).prctl(1, signal.SIGKILL)
    if os.getppid() != parent:
        return
    try:
        request = json.loads(sys.stdin.read(16384))
        endpoint = request["endpoint"]
        if endpoint not in ENDPOINTS:
            raise ValueError("Unknown endpoint")
        with open(os.devnull, "w") as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
            import akshare

            data = getattr(akshare, endpoint)(**request["parameters"])
            if len(data) > 100000:
                raise ValueError("Bounded snapshot capacity exceeded")
            # Preserve decimal text supplied by pandas, without JSON NaN/Infinity.
            records = data.astype(object).where(data.notna(), None).to_dict(orient="records")
            records = [{str(key): str(value) if value is not None else None
                        for key, value in row.items()} for row in records]
        payload = {"status": "data" if records else "empty_success", "records": records}
    except Exception as error:
        # Never echo SDK exceptions, requests, cookies, environment or proxy URLs.
        payload = {"status": "unavailable", "records": [], "error_type": type(error).__name__}
    sys.stdout.write(json.dumps(payload, ensure_ascii=False, allow_nan=False))


if __name__ == "__main__":
    main()
