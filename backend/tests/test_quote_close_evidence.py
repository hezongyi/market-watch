"""A closed bucket with confirmed early minutes need not have a closing price."""

from datetime import datetime
from decimal import Decimal
from types import SimpleNamespace

import pytest
from alerts import composite_quotes, history_artifacts
from alerts.quote_presentation import fixed_snapshot


def stamp(value):
    return int(datetime.fromisoformat(value).timestamp() * 1000)


@pytest.mark.parametrize("reader", ["history", "composite"])
@pytest.mark.parametrize("closing", ["missing", "confirmed", "unconfirmed", "different_price"])
def test_daily_change_requires_a_confirmed_closing_minute(monkeypatch, reader, closing):
    start = stamp("2026-01-05T22:00:00+00:00")
    end = stamp("2026-01-06T22:00:00+00:00")
    now = stamp("2026-01-07T12:00:00+00:00")
    instrument = SimpleNamespace(id="MD:close-evidence", calendar="ny17", calendar_profile={})
    version = SimpleNamespace(id="fixed-close-evidence", start=start, end=end + 86400000)
    dataset = SimpleNamespace(volume_kind="price_count", volume_unit="quotes")
    state = {"start": start, "end": end, "open": "1.10", "high": "1.10",
        "low": "1.10", "close": "1.10", "volume": "1", "volume_present": True,
        "observed": 1, "source_confirmed": True, "conflict": False}
    daily = history_artifacts._finish(state, instrument, version, dataset)
    assert daily["source_confirmed"] and daily["time_closed"]
    assert not daily["coverage_complete"]
    minute_start = start if closing == "missing" else end - 60000
    minute = history_artifacts._finish({**state, "start": minute_start,
        "end": minute_start + 60000, "source_confirmed": closing != "unconfirmed",
        "close": "1.09" if closing == "different_price" else "1.10"}, instrument, version, dataset)
    latest = {"start": now, "end": now + 60000, "close": "1.12"}
    calls = []

    def page(db, ident, frame, **kwargs):
        calls.append((ident, frame, kwargs))
        return {"bars": [daily] if frame == "D1" else [minute if kwargs.get("before") else latest]}

    if reader == "history":
        monkeypatch.setattr(history_artifacts, "chart_page", page)
        result = fixed_snapshot(None, version.id, {"frames": ["M1"], "calendar": "ny17"})
        assert result["lp"] == 1.12
        baseline = result.get("prev_close_price")
        if closing != "confirmed":
            assert "ch" not in result and "chp" not in result
        else:
            assert result["chp"] == pytest.approx(100 * 0.02 / 1.1)
        assert all(call[0] == version.id for call in calls)
    else:
        monkeypatch.setattr(composite_quotes, "chart_page", page)
        monkeypatch.setattr(composite_quotes, "_previous_close_cache", {})
        db = SimpleNamespace(get_bind=lambda: None)
        composite = SimpleNamespace(id="composite-close-evidence")
        revision = SimpleNamespace(id="revision-close-evidence", rules={"aggregation_calendar": "ny17"})
        baseline = composite_quotes.previous_close(db, composite, revision=revision,
            input_revision=3, observed_at=now)
        assert all(call[2]["revision_id"] == revision.id and call[2]["input_revision"] == 3
            and call[2]["provisional"] is False for call in calls)
    if closing == "confirmed":
        assert baseline == (Decimal("1.10") if reader == "composite" else 1.1)
    else:
        assert baseline is None
