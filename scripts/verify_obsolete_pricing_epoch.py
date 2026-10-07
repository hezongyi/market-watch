"""Reject a controlled old-epoch heartbeat against the actual recovered owner.

No fake prices are supplied. The heartbeat is deliberately obsolete and must
fail before any source state can be published. Tokens stay inside the process.
"""

import json
from pathlib import Path

from alerts.config import settings
from alerts.live_pricing import account_key, desired_datasets, publish_event
from alerts.storage import PricingOwner, now_ms, transaction


def main():
    previous = json.loads(Path("artifacts/data-integration/concurrency10-obsolete-owner-held.json").read_text())
    with transaction() as db:
        owner = db.get(PricingOwner, account_key(settings.oanda_account_id))
        ownership, epoch = (owner.id, owner.token), owner.epoch
        assert ownership[1] and owner.expires > now_ms() and epoch > previous["epoch"]
    identities = desired_datasets(settings.oanda_account_id)
    try:
        publish_event(ownership, previous["epoch"], {"type":"heartbeat",
            "connection_epoch":previous["epoch"],"received_at":now_ms()}, identities)
    except TimeoutError:
        print(json.dumps({"passed":True,"previous_epoch":previous["epoch"],"current_epoch":epoch,
            "sources":len(identities),"old_epoch_rejected_before_publication":True,
            "meaning":"controlled obsolete heartbeat against actual PostgreSQL ownership; no supplier price altered"}))
    else:
        raise AssertionError("Current owner accepted an obsolete connection epoch")


if __name__=="__main__":
    main()
