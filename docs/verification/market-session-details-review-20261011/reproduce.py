"""Synthetic, process-local reproductions; no account or provider requests."""

import json
from collections import OrderedDict
from datetime import datetime
from unittest.mock import patch

from alerts import provider_chart
from alerts.market_calendar import calendar_rows, session_status
from alerts.market_data import _session_observation


def stamp(value):
    return int(datetime.fromisoformat(value).timestamp() * 1000)


now = stamp("2026-10-10T11:45:00+00:00")
closed = session_status("dukascopy", "XAU/USD", now)
profile = {
    "revision": "foreign-account-fixture",
    "source_session": {
        "source": "oanda", "channel": "v20", "environment": "live",
        "provider_symbol": "EUR_USD", "account_scope": "sha256:" + "a" * 64,
        "timezone": "America/New_York",
        "reviewed_start": "2026-01-01T00:00:00+00:00",
        "reviewed_end": "2027-01-01T00:00:00+00:00",
        "evidence_url": "https://example.test/rule",
        "applicability": "Synthetic foreign account",
        "weekly_closures": [{"start": 6780, "end": 10080}],
    },
    "closures": [],
}
meta = {
    "calendar_profile": profile, "calendar_verified": True,
    "native_identity": {
        "source": "oanda", "channel": "v20", "environment": "practice",
        "provider_symbol": "EUR_USD", "account_scope": "sha256:" + "b" * 64,
    },
}
results = {
    "normal_friday_quote_on_saturday": _session_observation(
        "dukascopy", "XAU/USD", closed, stamp("2026-10-09T20:00:00+00:00"), {}
    ),
    "quote_inside_saturday_closure": _session_observation(
        "dukascopy", "XAU/USD", closed, now, {}
    ),
    "valid_weekend_after_suggested_review": session_status(
        "dukascopy", "XAU/USD", stamp("2026-11-14T12:00:00+00:00")
    ),
    "foreign_account_and_environment_profile": session_status(
        "oanda", "EUR_USD", now, metadata=meta
    ),
    "search_XAUUSD": len(calendar_rows(source="dukascopy", query="XAUUSD")),
    "search_XAU_slash_USD": len(calendar_rows(source="dukascopy", query="XAU/USD")),
}
quote_meta = {
    "source": "oanda", "id": "OANDA:EUR_USD", "symbol": "EUR_USD",
    "basis": "bid", "calendar": "ny17", "calendar_profile": None,
}
page = {"bars": [{"start": 120000, "end": 180000, "close": "1.25"}], "as_of": 190000}
with patch.object(provider_chart, "_QUOTE_LAST", OrderedDict()), patch.object(
    provider_chart, "cached_page", side_effect=[page, RuntimeError("fixture refresh failure")]
), patch.object(provider_chart.settings, "oanda_account_id", "fixture-account-A"):
    provider_chart.quote_page(quote_meta)
    provider_chart.settings.oanda_account_id = "fixture-account-B"
    results["old_account_cache_after_account_switch"] = provider_chart.quote_page(quote_meta)

print(json.dumps(results, ensure_ascii=False, indent=2))
