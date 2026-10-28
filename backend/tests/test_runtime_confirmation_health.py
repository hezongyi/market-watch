"""Runtime health follows persisted confirmation recovery, not quote success."""

import pytest
from alerts import live_confirmation, live_pricing, oanda_worker
from alerts.market_contracts import RequestResult
from alerts.storage import LiveState
from test_live_pricing import candles
from test_live_pricing import running as _running

running = _running


@pytest.mark.parametrize("status", ["timeout", "rate_limited", "unavailable"])
def test_confirmation_error_survives_backoff_peer_success_and_quotes(running, monkeypatch, status):
    factory, ownership, epoch, identities = running
    failed = identities["EUR_USD"]
    peer = identities["XAU_USD"]
    monkeypatch.setattr(oanda_worker, "session_states", lambda items: {
        key: {"market_session": "open"} for key in items})

    class Adapter:
        def page(self, identity, *_):
            if identity == failed:
                return candles(identity, rows=(), checkpoint=None,
                               result=RequestResult(status=status))
            return candles(identity)

    # Ordinary failures keep the existing local retry instead of disconnecting.
    assert oanda_worker.confirm_pages(Adapter(), ownership, epoch, identities, lambda: False) is None
    assert live_confirmation.runtime_error(identities, epoch) == status
    with factory() as db:
        assert db.get(LiveState, failed.key).next_confirm_at > 125000
    # The failed identity is skipped by its next_at; another success is not recovery.
    assert oanda_worker.confirm_pages(Adapter(), ownership, epoch, identities, lambda: False) is None
    assert live_confirmation.runtime_error(identities, epoch) == status
    from test_live_pricing import quote

    live_pricing.publish_event(ownership, epoch, quote(failed, epoch), identities, now=125000)
    assert live_confirmation.runtime_error(identities, epoch) == status
    assert live_confirmation.runtime_error({"peer": peer}, epoch) is None
    assert live_confirmation.runtime_error(identities, epoch + 1) is None
    with factory.begin() as db:
        db.get(LiveState, failed.key).next_confirm_at = 0

    class Recovered:
        def page(self, identity, *_):
            return candles(identity)

    assert oanda_worker.confirm_pages(Recovered(), ownership, epoch, identities, lambda: False) is None
    assert live_confirmation.runtime_error(identities, epoch) is None
