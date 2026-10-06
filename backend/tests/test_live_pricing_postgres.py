"""Account ownership contention and fencing on the isolated PostgreSQL service."""

import os
from concurrent.futures import ThreadPoolExecutor

import pytest
from alerts import live_pricing as live
from alerts.storage import LiveState, PricingOwner
from sqlalchemy import select
from test_live_pricing import quote
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(
    not os.getenv("TEST_POSTGRES_URL"), reason="Requires isolated Ubuntu Docker PostgreSQL"
)


def test_competing_collectors_and_superseded_connection_are_fenced(provider_pg):
    factory, _ = provider_pg
    live.ensure_catalog([
        {"name": "EUR_USD", "type": "CURRENCY", "displayPrecision": 5},
        {"name": "XAU_USD", "type": "METAL", "displayPrecision": 3},
    ], "acceptance-test-account")
    identities = live.desired_datasets("acceptance-test-account")
    with ThreadPoolExecutor(max_workers=4) as pool:
        claims = list(pool.map(lambda _: live.claim("acceptance-test-account"), range(4)))
    owners = [owner for owner in claims if owner]
    assert len(owners) == 1
    previous = owners[0]
    epoch = live.begin_connection(previous, identities)
    with factory.begin() as db:
        db.get(PricingOwner, previous[0]).expires = 0
    successor = live.claim("acceptance-test-account")
    next_epoch = live.begin_connection(successor, identities)
    assert next_epoch == epoch + 1
    with pytest.raises(TimeoutError):
        live.publish_event(previous, epoch, quote(identities["EUR_USD"], epoch), identities)
    with factory.begin() as db:
        assert all(state.quote == {} for state in db.scalars(select(LiveState)))
    live.publish_event(successor, next_epoch, quote(identities["EUR_USD"], next_epoch), identities)
    with factory.begin() as db:
        assert db.get(LiveState, identities["EUR_USD"].key).quote["connection_epoch"] == next_epoch
