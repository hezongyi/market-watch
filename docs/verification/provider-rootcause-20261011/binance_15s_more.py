"""Read-only sequential provider comparisons; at most one request per second."""
import json, re, ssl, sys, time
from collections import Counter
from urllib.parse import urlparse
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
print(json.dumps({"proxy_scheme":urlparse(settings.effective_binance_proxy).scheme,
    "verify":True,"trust_env":False}),flush=True)
counts = Counter()
timeout=15 if "--confirm" in sys.argv else 5
modes=[("configured_fresh",18),("direct_fresh",6)] if "--confirm" in sys.argv else [("configured_fresh",12),("configured_reused",12),("direct_fresh",3)]
for mode, count in modes:
    events = []
    def trace(name, info):
        # Never emit host, request, URL or response objects.
        if name.endswith((".started", ".failed")):
            events.append(name)
    def prepare(request):
        request.extensions["trace"] = trace
    proxy = None if mode == "direct_fresh" else settings.effective_binance_proxy or None
    def new_client():
        return httpx.Client(timeout=timeout, proxy=proxy, trust_env=False,event_hooks={"request":[prepare]})
    reused = new_client() if mode == "configured_reused" else None
    try:
        for attempt in range(1,count+1):
            started = time.monotonic()
            events.clear()
            client = reused or new_client()
            row = {"mode":mode,"attempt":attempt}
            try:
                payload = fetch_binance(client=client)
                row.update(result="ok",rows=len(payload["rows"]))
            except Exception as exc:
                row.update(result="error",chain=chain(exc))
            finally:
                if reused is None:
                    client.close()
            row.update(seconds=round(time.monotonic()-started,3),transport_events=list(events))
            counts[mode+":"+row["result"]]+=1
            print(json.dumps(row),flush=True)
            time.sleep(max(0,1-(time.monotonic()-started)))
    finally:
        if reused:
            reused.close()
print(json.dumps({"counts":counts}),flush=True)
assert not counts['configured_fresh:error'], 'configured Binance route intermittently fails before data arrives'
