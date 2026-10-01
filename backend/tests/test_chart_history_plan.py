from datetime import UTC, datetime

from alerts.chart_history_plan import history_start
from alerts.storage import Instrument, ms


def test_ny_dst_and_weekend_buckets(database):
    with database.begin() as db:
        inst = db.get(Instrument, 'XAUUSD')
        end = ms(datetime(2026, 3, 9, 21, tzinfo=UTC))
        # Monday close after US spring change: previous Friday opened Thursday
        # at 22 UTC; no invented weekend day counts toward the two bars.
        assert history_start(inst, 'D1', end, 2) == ms(datetime(2026, 3, 5, 22, tzinfo=UTC))


def test_calendar_boundary_scan_matches_minute_scan():
    from datetime import timedelta

    from alerts.calendar_profile import Closure
    from alerts.chart_history_plan import bucket_has_trading
    from alerts.domain import Calendar, has_trading_gap

    start = datetime(2026, 3, 5, 22, tzinfo=UTC)
    closures = (Closure(start=start, end=start+timedelta(hours=23,minutes=17),
                        reason='test',source='https://example.com/calendar'),)
    for hours in (1, 6, 24, 48, 96):
        right = start+timedelta(hours=hours)
        for gold in (False, True):
            assert bucket_has_trading(start,right,Calendar.NY17,gold,closures) == has_trading_gap(
                start,right,Calendar.NY17,gold=gold,closures=closures)


def test_boundary_gap_scan_matches_reference_across_both_dst_changes():
    from datetime import timedelta

    from alerts.calendar_profile import Closure
    from alerts.chart_history_plan import bucket_has_trading
    from alerts.domain import Calendar, has_trading_gap

    for start in (datetime(2026, 3, 6, 21, tzinfo=UTC),
                  datetime(2026, 10, 30, 21, tzinfo=UTC)):
        closure = Closure(start=start+timedelta(days=2),
                          end=start+timedelta(days=3, minutes=17),
                          reason='irregular reopen', source='https://example.com/calendar')
        for calendar in (Calendar.NY17, Calendar.UTC0):
            for gold in (False, True):
                for hours in (48, 72, 96):
                    end = start+timedelta(hours=hours)
                    assert bucket_has_trading(start, end, calendar, gold, (closure,)) == (
                        has_trading_gap(start, end, calendar, gold=gold, closures=(closure,)))


def test_forward_navigation_window_respects_weekend_and_dst(database):
    from alerts.chart_history_plan import history_end
    with database.begin() as db:
        inst = db.get(Instrument, 'XAUUSD')
        start = ms(datetime(2026, 3, 5, 22, tzinfo=UTC))
        assert history_end(inst, 'D1', start, 2) == ms(datetime(2026, 3, 9, 21, tzinfo=UTC))
        end = history_end(inst, 'M1', start, 600)
        # Gold's NY17 daily maintenance hour is excluded from minute counts.
        assert history_start(inst, 'M1', end, 600) == start + 3600000
