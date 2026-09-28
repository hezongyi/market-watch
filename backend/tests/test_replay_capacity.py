import json
from decimal import Decimal

from alerts import api as api_module
from alerts.service import add_replay_watch, replay_step
from alerts.storage import Bar, Replay
from sqlalchemy import insert, select


def test_large_warmup_survives_chart_limit_revision_and_seek(database):
    count = 20005
    rows = []
    for i in range(count + 1):
        o, h, low, c = (
            (10, 11, 8, 9)
            if i == 0
            else (9, 10, 7, 8)
            if i == 1
            else (8, 12, 7, 11)
            if i == count
            else (8, 10, 7, 8)
        )
        rows.append(
            dict(
                instrument_id="BTCUSDT",
                timeframe="M5",
                start=i * 300000,
                end=(i + 1) * 300000,
                open=Decimal(o),
                high=Decimal(h),
                low=Decimal(low),
                close=Decimal(c),
                complete=True,
            )
        )
    with database.begin() as db:
        db.execute(insert(Bar), rows)
    data = api_module.new_replay(
        api_module.ReplayInput(
            instrument_id="BTCUSDT", timeframe="M5", start=count * 300000, end=(count + 1) * 300000
        )
    )
    assert data["warmup_bar_count"] == count
    assert len(data["bars"]) == 500 and data["chart_history_limited"]
    assert all(b["end"] <= data["cursor"] for b in data["bars"])
    # Revisions to live history must not destroy the old setup in the snapshot.
    with database.begin() as db:
        first = db.scalar(select(Bar).where(Bar.start == 0))
        first.close = first.open
    branch = api_module.seek(data["id"], api_module.SeekInput(cursor=data["cursor"]))
    with database.begin() as db:
        run = db.get(Replay, branch["id"])
        assert "warmup_snapshot" not in run.__dict__  # deferred during ordinary reads
        api_module.replay_dict(run)
        assert "warmup_snapshot" not in run.__dict__
        add_replay_watch(
            run,
            "long waiting setup",
            {"kind": "pullback", "timeframe": "M5", "direction": "buy"},
            "utc0",
        )
        assert run.watches[0]["state"]["buy_ready"]
        replay_step(run, "utc0")
        assert len(run.signals) == 1
        assert run.signals[0]["price"] == "11.0000000000"
    exported = json.loads(api_module.export_replay(branch["id"]).body)
    assert len(exported["bars"]) == count + 1
    assert len({b["start"] for b in exported["bars"]}) == count + 1
    assert all(b["end"] <= exported["cursor"] for b in exported["bars"])
    assert exported["bars"][0]["close"] == "9.0000000000"
