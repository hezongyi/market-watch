"""Read-only upstream GETs in existing production worker; no DB operations."""
import json, re, time, ssl
import httpx
from alerts.config import settings
from alerts.providers import fetch_binance

def safe(value):
    return re.sub(r"(?:https?|socks5h?)://\S+", "[URL REDACTED]", str(value))
def chain(exc):
    out, seen = [], set()
    while exc and id(exc) not in seen:
        seen.add(id(exc))
        out.append({"type": type(exc).__name__, "message": safe(exc)})
        exc = exc.__cause__ or exc.__context__
    return out
print(json.dumps({"binance_proxy_set": bool(settings.binance_proxy),
    "market_proxy_set": bool(settings.market_proxy),
    "effective_binance_proxy_set": bool(settings.effective_binance_proxy),
    "openssl": ssl.OPENSSL_VERSION, "verify": True, "trust_env": False}))
failures = 0
with httpx.Client(timeout=15, proxy=settings.effective_binance_proxy or None, trust_env=False) as client:
    for attempt in range(1,4):
        started = time.monotonic()
        try:
            result = fetch_binance(client=client)
            print(json.dumps({"attempt":attempt, "result":"ok", "rows":len(result["rows"]),
                "seconds":round(time.monotonic()-started,3)}), flush=True)
        except Exception as exc:
            failures += 1
            print(json.dumps({"attempt":attempt, "result":"error", "chain":chain(exc),
                "seconds":round(time.monotonic()-started,3)}), flush=True)
print(json.dumps({"failures":failures, "attempts":3}))
raise SystemExit(1 if failures else 0)
