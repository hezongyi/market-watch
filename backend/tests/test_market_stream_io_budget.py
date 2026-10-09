"""Idle transport must not write leases on every half-second delivery check."""

from alerts import market_stream as stream
from alerts.storage import MarketStreamSubscription
from sqlalchemy import event, select
from test_market_stream import register, session


def test_idle_connection_does_not_rewrite_all_leases_each_delivery_poll(database):
    owner = session(database)
    for index in range(8):
        register(owner, listener=f"chart-{index}")
    stream.renew(owner, "page")
    stream.events(owner, "page", {})
    from alerts.market_stream import client_key
    from alerts.storage import MarketStreamClient
    with database.begin() as db:
        expiry = db.get(MarketStreamClient, client_key(owner, "page")).expires
    assert expiry - stream.now_ms() > stream.LEASE_MS * 2 // 3
    statements = []
    engine = database.kw["bind"]

    def observe(connection, cursor, statement, parameters, context, executemany):
        verb = statement.lstrip().split(None, 1)[0].upper()
        if verb in ("INSERT", "UPDATE", "DELETE"):
            statements.append((statement, parameters))

    event.listen(engine, "before_cursor_execute", observe)
    try:
        cursors = {}
        for _ in range(6):
            stream.renew(owner, "page")
            assert stream.events(owner, "page", cursors) == []
    finally:
        event.remove(engine, "before_cursor_execute", observe)
    assert not statements, (
        f"Six idle delivery polls rewrote leases {len(statements)} times "
        f"after {expiry - stream.now_ms()}ms remained; "
        "the 120-second lease must be renewed at a bounded cadence"
    )


def test_registering_new_listeners_does_not_starve_existing_lease(database, monkeypatch):
    owner = session(database)
    stamp = stream.now_ms()
    monkeypatch.setattr(stream, "now_ms", lambda: stamp)
    register(owner, listener="first")
    for offset in (30000, 60000, 90000):
        monkeypatch.setattr(stream, "now_ms", lambda: stamp + offset)
        register(owner, listener=f"later-{offset}")
        stream.renew(owner, "page")
    monkeypatch.setattr(stream, "now_ms", lambda: stamp + 125000)
    stream.renew(owner, "page")
    with database.begin() as db:
        first = db.scalar(select(MarketStreamSubscription).where(
            MarketStreamSubscription.listener == "first"))
        assert first.active and first.expires > stream.now_ms(), (
            "New registrations must not postpone renewal of an older active listener"
        )
