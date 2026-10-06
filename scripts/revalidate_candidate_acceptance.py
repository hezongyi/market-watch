"""Run only against this project's Ubuntu acceptance database."""

import json

from alerts.calendar_revalidation import revalidate_page
from alerts.storage import Instrument, MarketDataset, transaction
from sqlalchemy import select

with transaction() as db:
    ids = [inst.id for inst in db.scalars(select(Instrument).join(MarketDataset,
        MarketDataset.instrument_id == Instrument.id)) if not inst.calendar_profile]
results = []
for ident in ids:
    for published in (False, True):
        after = examined = retracted = pages = 0
        while True:
            result = revalidate_page(ident, after=after, published=published)
            if not result["examined"]:
                break
            after = result["after"]
            examined += result["examined"]
            retracted += result["retracted"]
            pages += 1
            if pages % 100 == 0:
                print(json.dumps({"event": "revalidation_checkpoint", "instrument": ident,
                    "published": published, "examined": examined, "retracted": retracted}), flush=True)
        results.append({"instrument": ident, "published": published,
                        "examined": examined, "retracted": retracted})
print(json.dumps({"event": "revalidation_completed", "host": "Ubuntu isolated Docker",
    "results": results, "immutable_history_and_replay_inputs": "unchanged"}), flush=True)
