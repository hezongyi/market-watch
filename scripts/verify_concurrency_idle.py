"""Check only this stage's released consumers and source owner actually idle."""

import json
import time
from pathlib import Path

from alerts.config import settings
from alerts.live_pricing import account_key, desired_datasets
from alerts.storage import LiveState, MarketDemand, PricingOwner, Watch, now_ms, transaction
from sqlalchemy import func, select


def main():
    setup = json.loads(Path("artifacts/data-integration/concurrency10-real-01.json").read_text())
    identities = {row["composite_id"] for row in setup["records"]}
    started = time.monotonic()
    while time.monotonic() - started < 180:
        desired = desired_datasets(settings.oanda_account_id)
        with transaction() as db:
            watches = [db.get(Watch, row["watch_id"]) for row in setup["records"]]
            assert all(watch.status == "cancelled" for watch in watches)
            leases = db.scalar(select(func.count()).select_from(MarketDemand).where(
                MarketDemand.instrument_id.in_(identities), MarketDemand.expires > now_ms()))
            owner = db.get(PricingOwner, account_key(settings.oanda_account_id))
            active_owner = bool(owner and owner.token and owner.expires > now_ms())
            states = list(db.scalars(select(LiveState)))
            inactive = all(state.connection == "inactive" for state in states)
        if not desired and not leases and not active_owner and inactive:
            print(json.dumps({"passed": True, "at": now_ms(), "owned_cancelled_watches": len(watches),
                "owned_active_chart_leases": leases, "desired_sources": 0,
                "active_stream_owner": False, "all_source_states_inactive": True,
                "wait_seconds": round(time.monotonic() - started, 3)}))
            return
        time.sleep(1)
    raise AssertionError("Recorded consumers were released but source idle was not established")


if __name__ == "__main__":
    main()
