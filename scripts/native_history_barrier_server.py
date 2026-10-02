"""Acceptance-only API entrypoint for deterministic PG revision barriers.

Use the unchanged tested API image/endpoints/SSE, but hold its autonomous
provider warm/live loops while injecting a revision. Otherwise the provider's
unchanged historical close can legitimately replace an injected test value.
This is not a product runtime or a performance cohort.
"""
from sqlalchemy.engine import make_url

from alerts import provider_service
from alerts.config import settings

url = make_url(settings.database_url)
assert url.host == "market-watch-native-history-pg"
assert url.database == "market_watch_native_history"
provider_service.start = lambda: None
provider_service.stop = lambda: None

if __name__ == "__main__":
    import uvicorn

    uvicorn.run("alerts.api:app", host="0.0.0.0", port=8000)
