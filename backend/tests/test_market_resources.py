from alerts.market_resources import acquire, release
from alerts.storage import ImportJob


def test_history_cannot_consume_reserved_realtime_slots_or_rate(database):
    now = 100000
    history = acquire("oanda", "history", now)
    assert history
    assert acquire("oanda", "history", now) is None
    rt1 = acquire("oanda", "realtime", now)
    rt2 = acquire("oanda", "realtime", now)
    assert rt1 and rt2 and rt1 != rt2
    assert acquire("oanda", "realtime", now) is None
    release("oanda", history)
    assert acquire("oanda", "history", now + 999) is None
    assert acquire("oanda", "history", now + 1000)
    assert acquire("binance", "history", now)


def test_crash_lease_expires_and_recent_repair_pauses_new_history(database):
    now = 100000
    assert acquire("oanda", "history", now)
    assert acquire("oanda", "history", now + 89999) is None
    assert acquire("oanda", "history", now + 90000)
    with database.begin() as db:
        db.add(ImportJob(instrument_id="BTCUSDT", start=0, end=60000, cursor=0, priority=0))
    assert acquire("binance", "history", now) is None
    assert acquire("binance", "realtime", now)


def test_chart_reads_do_not_wait_for_watchlist_or_backfill_reservations(database):
    now = 100000
    assert acquire("oanda", "history", now)
    assert acquire("oanda", "chart", now)
    assert acquire("oanda", "chart", now)
    assert acquire("oanda", "chart", now) is None
    assert acquire("oanda", "realtime", now)
    assert acquire("oanda", "realtime", now)
    with database.begin() as db:
        db.add(ImportJob(instrument_id="BTCUSDT", start=0, end=60000, cursor=0, priority=0))
    assert acquire("binance", "history", now) is None
    assert acquire("binance", "chart", now)
    assert acquire("binance", "realtime", now)
