"""Differential tests against the authoritative aggregation interface."""

import pytest
from alerts.composite_realtime import Bucket
from alerts.composite_series import aggregate
from test_composite_series import row, segments, stamp


@pytest.mark.parametrize("frame", ["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN"])
@pytest.mark.parametrize("phase", ["utc0", "ny17"])
@pytest.mark.parametrize("at", ["2026-03-08T22:00:00+00:00", "2026-11-01T23:00:00+00:00",
                              "2026-03-31T22:00:00+00:00"])
def test_replace_confirm_retract_matches_authoritative_prices_coverage_and_provenance(frame, phase, at):
    time = stamp(at)
    meta = segments()
    state = Bucket(time, frame, phase=phase, seam=time, segments=meta,
                   revision_id="fixed", history_start=0)
    inputs = {}

    def check():
        expected = aggregate([inputs[t] for t in sorted(inputs)], frame, phase=phase, seam=time,
            segments=meta, revision_id="fixed", input_revision=2, now=time + 100000, history_start=0)
        assert state.result(input_revision=2, now=time + 100000) == (expected[0] if expected else None)

    if state.left < time:
        confirmed = row(time - 60000, "history", volume="2")
        inputs[confirmed["timestamp"]] = confirmed
        state.replace(confirmed)
    forming = row(time, "target", high="1.50", low="0.9", close="1.15", complete=False, volume=None)
    forming["provisional_input"] = {"epoch": "test", "minute": dict(forming)}
    inputs[time] = forming
    state.replace(forming)
    check()
    # A replacement can shrink both extremes; provisional observations are not
    # accumulated into the confirmed prefix or official volume.
    confirmation = row(time, "target", high="1.2", low="1.1", close="1.12", volume="3")
    inputs[time] = confirmation
    state.replace(confirmation)
    check()
    state.remove(time)
    inputs.pop(time)
    check()


def test_quote_updates_do_not_rescan_calendar_and_extremes_storage_is_bounded(monkeypatch):
    import alerts.composite_realtime as realtime

    state = Bucket(0, "MN", phase="utc0", seam=0, segments=segments(),
                   revision_id="fixed", history_start=0)
    monkeypatch.setattr(realtime, "_closed", lambda *_: pytest.fail("calendar rescanned"))
    for i in range(500):
        state.replace(row(0, "target", high=str(2 + i / 1000), complete=False, volume=None))
        result = state.result(input_revision=1, now=1000)
        assert result["observed_minutes"] == 1 and not result["source_confirmed"]
    assert len(state.highs) + len(state.lows) <= 4 * len(state.rows) + 128
