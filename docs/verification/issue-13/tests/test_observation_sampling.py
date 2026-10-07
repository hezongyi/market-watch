"""Lightweight SQLite contracts for the measured sampler, without services."""

import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import Session

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from observation_sampling import published_query, read_sample
from alerts.storage import ChartAlert, ChartPublishedBar, Instrument


@pytest.mark.parametrize("latest", [False, True])
def test_two_queries_preserve_payload_and_alert_lifecycle(latest):
    engine = create_engine("sqlite://")
    for model in (Instrument, ChartPublishedBar, ChartAlert):
        model.__table__.create(engine)
    alerts = {f"actual-{i}": f"alert-{i}" for i in range(10)}
    expected = {}
    with Session(engine) as db, db.begin():
        for i, (ident, alert_id) in enumerate(alerts.items()):
            db.add(Instrument(id=ident, label="same symbol", symbol="EURUSD", source="oanda",
                              basis="bid", calendar="utc0", precision=5))
            for frame, start in (("M1", 0), ("M1", 60000), ("M1", 120000), ("M5", 300000)):
                payload = dict(start=start, end=start + 60000, observed_at=700000 + start + i,
                               open="1", high="2", low="0", close=str(i), complete=True,
                               volume=str(i + 1), volume_complete=True, revision=i + 1)
                db.add(ChartPublishedBar(instrument_id=ident, timeframe=frame, start=start,
                                        end=payload["end"], complete=True, payload=payload))
                if frame == "M1" and start == (120000 if latest else 60000):
                    expected[ident] = payload
            db.add(ChartAlert(id=alert_id, request_id=alert_id, request_hash="hash", name="test",
                              effective_at=0, state={"sequence": i}, count=i,
                              health="stale" if i % 2 else "ready",
                              status="paused" if i % 2 else "active"))
    statements = []
    event.listen(engine, "before_cursor_execute",
                 lambda conn, cursor, sql, params, context, many: statements.append(sql))
    try:
        with Session(engine) as db:
            actual = read_sample(db, alerts, start=None if latest else 60000)
        assert len(statements) == 2
        for i, ident in enumerate(alerts):
            assert actual[ident] == dict(published_observed_at=expected[ident]["observed_at"],
                                        payload=expected[ident], sequence=i, count=i,
                                        health="stale" if i % 2 else "ready",
                                        status="paused" if i % 2 else "active")
        if latest:
            sql = str(published_query(alerts).compile(engine, compile_kwargs={"literal_binds": True}))
            with engine.connect() as conn:
                plan = [row[-1] for row in conn.execute(text("EXPLAIN QUERY PLAN " + sql))]
            assert any("SEARCH chart_published_bars USING INDEX" in step for step in plan), plan
            assert not any("SCAN chart_published_bars" in step for step in plan), plan
    finally:
        engine.dispose()


def test_missing_payload_is_not_filled_from_another_identity():
    engine = create_engine("sqlite://")
    for model in (Instrument, ChartPublishedBar, ChartAlert):
        model.__table__.create(engine)
    try:
        with Session(engine) as db:
            with pytest.raises(KeyError):
                read_sample(db, {"missing-identity": "missing-alert"})
    finally:
        engine.dispose()
