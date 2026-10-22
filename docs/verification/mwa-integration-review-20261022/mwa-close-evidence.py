"""Read-only closing-minute proof for the existing mwa acceptance examples."""
import json
from decimal import Decimal

from alerts.composite_chart import chart_page as composite_page
from alerts.composite_quotes import snapshot
from alerts.composite_series import period
from alerts.domain import Calendar, bucket_bounds
from alerts.history_artifacts import chart_page as history_page
from alerts.quote_close import confirmed_daily_close
from alerts.quote_presentation import fixed_snapshot
from alerts.series_access import metadata
from alerts.storage import CompositeRevision, MarketComposite, instant, transaction


def proof(daily, minute):
    return {"daily": {k: daily.get(k) for k in (
        "start", "end", "close", "source_confirmed", "time_closed", "coverage_complete")},
        "closingMinute": {k: minute.get(k) for k in (
            "start", "end", "close", "complete", "source_confirmed", "time_closed")}}


with transaction() as db:
    composite = db.get(MarketComposite, "8c490df00408ed7102d9106e2ad6d3991d3e6488de0b0905d92a2ec052343cbb")
    result = snapshot(db, composite)
    revision = db.get(CompositeRevision, result["revision_id"])
    observed = (result["provenance"]["candle"]["start"]
        if result["price_type"] == "sampled_candle_close" else result["observed_at"])
    start, _ = period(observed, "D1", revision.rules["aggregation_calendar"])
    pinned = dict(revision_id=revision.id, input_revision=result["input_revision"],
        provisional=False, now=observed)
    daily = composite_page(db, composite.id, "D1", before=start, count=1, **pinned)["bars"][-1]
    minute = composite_page(db, composite.id, "M1", before=daily["end"], count=1, **pinned)["bars"][-1]
    close = confirmed_daily_close(daily, minute)
    assert close is not None and Decimal(result["previous_close"]) == close
    composite_proof = {**proof(daily, minute), "revision": revision.id,
        "inputRevision": result["input_revision"], "previousClose": str(close),
        "price": str(result["price"])}

    ident = "63bc01d4-3943-45cc-93a5-b04c3caaab16"
    meta = metadata(db, ident, "history")
    fixed = fixed_snapshot(db, ident, meta)
    boundary, _ = bucket_bounds(instant(fixed["data_start"]), "D1", Calendar(meta["calendar"]))
    daily = history_page(db, ident, "D1", before=int(boundary.timestamp()*1000), count=1)["bars"][-1]
    minute = history_page(db, ident, "M1", before=daily["end"], count=1)["bars"][-1]
    close = confirmed_daily_close(daily, minute)
    assert close is not None and Decimal(str(fixed["prev_close_price"])) == close
    historical_proof = {**proof(daily, minute), "historyVersion": ident,
        "previousClose": str(close), "price": fixed["lp"], "changePercent": fixed["chp"]}
    print(json.dumps({"composite": composite_proof, "history": historical_proof,
        "readOnly": True, "passed": True}, indent=2))
