from datetime import datetime, timedelta
from decimal import Decimal

import pytest
from alerts import api as api_module
from alerts.chart_data import bounds, chart_rows, future_grid
from alerts.chart_indicators import CATALOG, calculate
from alerts.domain import TIMEFRAMES, Calendar, session_bounds
from alerts.storage import Bar, Instrument, ms
from fastapi.testclient import TestClient


def dt(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def test_calendar_boundaries():
    left, right = bounds(dt("2026-03-09T12:00Z"), "W1", Calendar.NY17)
    assert left == dt("2026-03-08T21:00Z")
    assert right == dt("2026-03-15T21:00Z")
    left, right = bounds(dt("2026-03-03T12:00Z"), "W1", Calendar.NY17)
    assert (right - left).total_seconds() == 7 * 86400 - 3600
    left, right = bounds(dt("2024-02-15T12:00Z"), "MN", Calendar.NY17)
    assert left == dt("2024-01-31T22:00Z") and right == dt("2024-02-29T22:00Z")
    left, right = bounds(dt("2026-12-31T18:00Z"), "W1", Calendar.UTC0)
    assert left == dt("2026-12-28T00:00Z") and right == dt("2027-01-04T00:00Z")
    assert "W1" not in TIMEFRAMES and "M30" not in TIMEFRAMES


def test_weekly_from_daily_and_revision(database):
    start = dt("2026-09-20T21:00Z")
    with database.begin() as db:
        inst = db.get(Instrument, "EURUSD")
        for i in range(5):
            left, right = session_bounds(start + timedelta(days=i), Calendar.NY17)
            db.add(
                Bar(
                    instrument_id=inst.id,
                    timeframe="D1",
                    start=ms(left),
                    end=ms(right),
                    open=Decimal(100 + i),
                    high=Decimal(110 + i),
                    low=Decimal(90 + i),
                    close=Decimal(102 + i),
                    complete=True,
                )
            )
        db.flush()

        def query():
            return chart_rows(
                db, inst, "W1", ms(start + timedelta(days=8)), 10, ms(start + timedelta(days=8))
            )

        row = query()[0]
        assert row["complete"] and float(row["open"]) == 100 and float(row["close"]) == 106
        assert float(row["high"]) == 114 and float(row["low"]) == 90
        first = db.query(Bar).filter_by(instrument_id=inst.id, timeframe="D1").first()
        first.high = Decimal(200)
        first.revision = 2
        db.flush()
        assert float(query()[0]["high"]) == 200 and query()[0]["revision"] == 2
        first.complete = False
        db.flush()
        assert not query()[0]["complete"]
        db.delete(first)
        db.flush()
        assert not query()[0]["complete"]
        assert future_grid(inst, "W1", ms(start))[0]["start"] == ms(start)


def test_indicators_and_warmup():
    rows = [
        {
            "start": i * 60000,
            "open": str(i + 1),
            "high": str(i + 3),
            "low": str(i + 0.5),
            "close": str(i + 2),
            "complete": True,
        }
        for i in range(100)
    ]
    for name in CATALOG:
        result = calculate(rows, {"name": name})
        assert all(len(s["values"]) == 100 for s in result["series"])
        assert result["series"][0]["values"][0]["value"] is None
    w = calculate(rows, {"name": "LWMA", "params": {"period": 3}})["series"][0]["values"]
    assert w[2]["value"] == pytest.approx((2 + 3 * 2 + 4 * 3) / 6)
    k = calculate(rows, {"name": "STOCH"})
    assert [s["key"] for s in k["series"]] == ["k", "d"]
    rows[80]["complete"] = False
    result = calculate(rows, {"name": "EMA"})
    assert result["series"][0]["values"][80]["value"] is None
    assert result["series"][0]["values"][-1]["value"] is None


def test_workspaces_conflict_copy_and_auth(database):
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with TestClient(api_module.app) as client:
            w = client.post("/api/charts/workspaces", json={"name": "A"}).json()
            doc = w["document"]
            doc["drawings"] = {
                "XAUUSD": [
                    {
                        "id": "line1",
                        "toolType": "TrendLine",
                        "points": [
                            {"timestamp": 100, "price": 10},
                            {"timestamp": 200, "price": 12},
                        ],
                        "options": {},
                    }
                ]
            }
            body = {"name": "A", "document": doc, "revision": 1}
            assert (
                client.post(f"/api/charts/workspaces/{w['id']}/save", json=body).status_code == 200
            )
            assert (
                client.post(f"/api/charts/workspaces/{w['id']}/save", json=body).status_code == 409
            )
            copied = client.post(
                f"/api/charts/workspaces/{w['id']}/copy", json={**body, "name": "B"}
            ).json()
            assert copied["document"]["drawings"]["XAUUSD"][0]["id"] != "line1"
            assert len(client.get("/api/charts/workspaces").json()) == 2
            body["document"]["panels"][0]["timeframe"] = "invalid"
            assert (
                client.post(f"/api/charts/workspaces/{w['id']}/save", json=body).status_code == 422
            )
    finally:
        api_module.app.dependency_overrides.clear()
    with TestClient(api_module.app) as client:
        assert client.get("/api/charts/workspaces").status_code == 401


def test_month_from_daily_and_half_hour(database):
    with database.begin() as db:
        inst = db.get(Instrument, "BTCUSDT")
        start = dt("2024-02-01T00:00Z")
        for i in range(29):
            db.add(
                Bar(
                    instrument_id=inst.id,
                    timeframe="D1",
                    start=ms(start + timedelta(days=i)),
                    end=ms(start + timedelta(days=i + 1)),
                    open=100 + i,
                    high=150 + i,
                    low=90 - i,
                    close=110 + i,
                    complete=True,
                )
            )
        for i in range(2):
            db.add(
                Bar(
                    instrument_id=inst.id,
                    timeframe="M15",
                    start=ms(start + timedelta(minutes=15 * i)),
                    end=ms(start + timedelta(minutes=15 * (i + 1))),
                    open=100 + i,
                    high=105 + i,
                    low=95 - i,
                    close=102 + i,
                    complete=True,
                )
            )
        db.flush()
        cutoff = ms(dt("2024-03-02T00:00Z"))
        month = chart_rows(db, inst, "MN", cutoff, 10, cutoff)[0]
        assert month["complete"] and list(
            map(float, (month["open"], month["high"], month["low"], month["close"]))
        ) == [100, 178, 62, 138]
        assert not chart_rows(db, inst, "MN", cutoff, 10, ms(start + timedelta(days=10)))[0][
            "complete"
        ]
        half = chart_rows(db, inst, "M30", cutoff, 10, cutoff)[0]
        assert half["complete"] and float(half["close"]) == 103
        first = db.query(Bar).filter_by(instrument_id=inst.id, timeframe="M15").first()
        db.delete(first)
        db.flush()
        assert not chart_rows(db, inst, "M30", cutoff, 10, cutoff)[0]["complete"]


def test_indicator_plugin_and_gap():
    import numpy as np
    from alerts.chart_indicators import CALCULATORS, register

    name = "TEST_DEVIATION_V1"
    try:
        register(
            name,
            {"label": "偏离", "pane": "sub", "params": {}},
            lambda h, low, c, p: {"value": c - c.mean() if len(c) else c},
        )
        rows = [
            {"start": i, "high": i + 3, "low": i + 1, "close": i + 2, "complete": True}
            for i in range(50)
        ]
        out = calculate(rows, {"name": name})
        assert np.isclose(out["series"][0]["values"][0]["value"], -24.5)
        rows[40]["gap_before"] = True
        ema = calculate(rows, {"name": "EMA", "params": {"period": 5}})["series"][0]["values"]
        assert (
            ema[39]["value"] is not None
            and ema[40]["value"] is None
            and ema[44]["value"] is not None
        )
    finally:
        CATALOG.pop(name, None)
        CALCULATORS.pop(name, None)


@pytest.mark.parametrize("value", [None, [None], "broken", {"x": None}])
def test_malformed_document_returns_422(database, value):
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with TestClient(api_module.app) as client:
            w = client.post("/api/charts/workspaces", json={"name": "validate"}).json()
            for field in ("panels", "drawings"):
                doc = {**w["document"], field: value}
                assert (
                    client.post(
                        f"/api/charts/workspaces/{w['id']}/save",
                        json={"name": "validate", "revision": 1, "document": doc},
                    ).status_code
                    == 422
                )
    finally:
        api_module.app.dependency_overrides.clear()


def test_gold_week_without_maintenance_coverage_is_incomplete(database):
    with database.begin() as db:
        inst = db.get(Instrument, "XAUUSD")
        start = dt("2026-09-20T21:00Z")
        closures = []
        for i in range(5):
            left, right = session_bounds(start + timedelta(days=i), Calendar.NY17)
            db.add(
                Bar(
                    instrument_id=inst.id,
                    timeframe="D1",
                    start=ms(left),
                    end=ms(right),
                    open=100,
                    high=110,
                    low=90,
                    close=105,
                    complete=True,
                )
            )
            closures.append(
                {
                    "start": left.isoformat(),
                    "end": (left + timedelta(minutes=64)).isoformat(),
                    "reason": "daily maintenance",
                    "source": "https://www.oanda.com/",
                    "kind": "maintenance",
                }
            )
        db.flush()
        cutoff = ms(start + timedelta(days=8))
        assert not chart_rows(db, inst, "W1", cutoff, 10, cutoff)[0]["complete"]
        inst.calendar_profile = {"revision": "test-week", "closures": closures}
        assert chart_rows(db, inst, "W1", cutoff, 10, cutoff)[0]["complete"]


def test_workspace_backup_round_trip(tmp_path, monkeypatch):
    from alerts import backup, storage
    from sqlalchemy import create_engine, select
    from sqlalchemy.orm import Session

    source = tmp_path / "chart-source.db"
    engine = create_engine(f"sqlite:///{source}")
    storage.bootstrap(engine)
    document = {
        "schemaVersion": 1,
        "layout": "1",
        "sync": True,
        "panels": [
            {
                "id": "panel",
                "instrument": "XAUUSD",
                "timeframe": "H4",
                "indicators": [
                    {"id": "ema", "name": "EMA", "version": "1", "params": {"period": 20}}
                ],
            }
        ],
        "drawings": {
            "XAUUSD": [
                {
                    "id": "line",
                    "toolType": "HorizontalLine",
                    "points": [{"timestamp": 100, "price": 2000}],
                    "options": {},
                }
            ]
        },
    }
    with Session(engine) as db:
        db.add(storage.ChartWorkspace(name="restore", document=document))
        db.commit()
    engine.dispose()
    monkeypatch.setattr(backup.settings, "database_url", f"sqlite:///{source}")
    target = tmp_path / "chart-backup.db"
    report = backup.backup(target)
    assert report["counts"]["chart_workspaces"] == 1
    assert backup.restore_check(target)["verified"]
    restored = create_engine(f"sqlite:///{target}")
    with Session(restored) as db:
        assert db.scalar(select(storage.ChartWorkspace)).document == document
    restored.dispose()


def test_indicator_pages_have_one_origin_and_revision_invalidates(database):
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with database.begin() as db:
            for i in range(100):
                db.add(
                    Bar(
                        instrument_id="BTCUSDT",
                        timeframe="M1",
                        start=60000 * (i + 1),
                        end=60000 * (i + 2),
                        open=100 + i,
                        high=103 + i,
                        low=99 + i,
                        close=101 + i,
                        complete=True,
                    )
                )
        with TestClient(api_module.app) as client:
            query = {
                "instrument": "BTCUSDT",
                "timeframe": "M1",
                "limit": 100,
                "indicators": [{"id": "ema", "name": "EMA", "params": {"period": 5}}],
            }
            all_data = client.post("/api/charts/data", json=query).json()
            page = client.post(
                "/api/charts/data", json={**query, "before": 60000 * 60, "limit": 10}
            ).json()
            values = {
                v["time"]: v["value"] for v in all_data["indicators"][0]["series"][0]["values"]
            }
            assert page["origin"] == all_data["origin"] == 60000
            assert all(
                v["value"] == values[v["time"]]
                for v in page["indicators"][0]["series"][0]["values"]
            )
            with database.begin() as db:
                bar = (
                    db.query(Bar)
                    .filter_by(instrument_id="BTCUSDT", timeframe="M1", start=60000 * 55)
                    .one()
                )
                bar.close = Decimal(1000)
                bar.high = Decimal(1001)
                bar.revision += 1
            updated = client.post(
                "/api/charts/data", json={**query, "before": 60000 * 60, "limit": 10}
            ).json()
            assert updated["history_revision"] != page["history_revision"]
            assert (
                updated["indicators"][0]["series"][0]["values"][-1]["value"]
                != page["indicators"][0]["series"][0]["values"][-1]["value"]
            )
    finally:
        api_module.app.dependency_overrides.clear()


def test_invalid_position_and_layout(database):
    from alerts.chart_api import checked

    document = {
        "schemaVersion": 1,
        "layout": "4",
        "panels": [{"id": "p", "instrument": "EURUSD", "timeframe": "M5", "indicators": []}],
        "drawings": {},
    }
    with pytest.raises(ValueError, match="图表数量"):
        checked(document)
    document["layout"] = "1"
    document["drawings"] = {
        "EURUSD": [
            {
                "id": "rr",
                "toolType": "LongShortPosition",
                "points": [{"timestamp": 100, "price": p} for p in [100, 110, 120]],
                "options": {},
            }
        ]
    }
    with pytest.raises(ValueError, match="止损"):
        checked(document)


@pytest.mark.parametrize("indicators", [[], [{"name": "EMA", "params": {"period": 2}}]])
@pytest.mark.parametrize("revision_after", [None, 120000])
def test_live_history_check_ignores_tail_but_detects_older_changes(
    database, indicators, revision_after
):
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with database.begin() as db:
            for i in range(1, 5):
                db.add(
                    Bar(
                        instrument_id="BTCUSDT",
                        timeframe="M1",
                        start=i * 60000,
                        end=(i + 1) * 60000,
                        open=100,
                        high=100,
                        low=100,
                        close=100,
                        complete=True,
                    )
                )
        with TestClient(api_module.app) as client:
            args = {"instrument": "BTCUSDT", "timeframe": "M1", "limit": 3, "track_history": True}
            args["revision_after"] = revision_after
            initial = client.post("/api/charts/data", json=args).json()["history_check"]
            with database.begin() as db:
                tail = db.query(Bar).filter_by(start=240000).one()
                tail.close = 101
                tail.high = 101
                tail.revision += 1
                tail.received_at += 1
                db.add(
                    Bar(
                        instrument_id="BTCUSDT",
                        timeframe="M1",
                        start=300000,
                        end=360000,
                        open=101,
                        high=101,
                        low=101,
                        close=101,
                        complete=True,
                    )
                )
            args["revision_before"] = initial["next_before"]
            current = client.post("/api/charts/data", json=args).json()["history_check"]
            assert current["revision"] == initial["next_revision"]
            assert current["next_before"] == 300000
            with database.begin() as db:
                old = db.query(Bar).filter_by(start=60000).one()
                old.close = 99
                old.low = 99
                old.revision += 1
            revised = client.post("/api/charts/data", json=args).json()["history_check"]
            if revision_after is None:
                assert revised["revision"] != initial["next_revision"]
            else:
                assert revised["revision"] == initial["next_revision"]
                assert revised["after"] == revision_after
                with database.begin() as db:
                    inside = db.query(Bar).filter_by(start=120000).one()
                    inside.revision += 1
                changed = client.post("/api/charts/data", json=args).json()["history_check"]
                assert changed["revision"] != initial["next_revision"]
    finally:
        api_module.app.dependency_overrides.clear()


def test_long_history_indicator_warmup_and_future_append(database):
    """API pages must use the full prefix, checked against independent recurrences."""
    import math

    closes = [round(100 + i / 1000 + math.sin(i / 11) * 7, 8) for i in range(6200)]
    with database.begin() as db:
        db.add_all(
            [
                Bar(
                    instrument_id="BTCUSDT",
                    timeframe="M1",
                    start=(i + 1) * 60000,
                    end=(i + 2) * 60000,
                    open=value,
                    high=value + 1,
                    low=value - 1,
                    close=value,
                    complete=True,
                )
                for i, value in enumerate(closes[:6000])
            ]
        )
    # Independent EMA(500) and Wilder RSI(14), without calling chart calculate/TA-Lib.
    ema = [None] * len(closes)
    ema[499] = sum(closes[:500]) / 500
    alpha = 2 / 501
    for i in range(500, len(closes)):
        ema[i] = ema[i - 1] + alpha * (closes[i] - ema[i - 1])
    rsi = [None] * len(closes)
    changes = [closes[i] - closes[i - 1] for i in range(1, len(closes))]
    gain = sum(max(v, 0) for v in changes[:14]) / 14
    loss = sum(max(-v, 0) for v in changes[:14]) / 14
    rsi[14] = 100 * gain / (gain + loss)
    for i in range(15, len(closes)):
        gain = (13 * gain + max(changes[i - 1], 0)) / 14
        loss = (13 * loss + max(-changes[i - 1], 0)) / 14
        rsi[i] = 100 * gain / (gain + loss)
    query = {
        "instrument": "BTCUSDT",
        "timeframe": "M1",
        "limit": 1200,
        "before": 5001 * 60000,
        "indicators": [
            {"name": "EMA", "params": {"period": 500}},
            {"name": "RSI", "params": {"period": 14}},
        ],
    }
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with TestClient(api_module.app) as client:

            def read(args):
                response = client.post("/api/charts/data", json=args)
                assert response.status_code == 200
                return response.json()

            page = read(query)
            assert len(page["bars"]) == 1200
            for indicator, reference in zip(page["indicators"], (ema, rsi)):
                values = indicator["series"][0]["values"]
                assert len(values) == 1200
                for point in values:
                    index = point["time"] // 60000 - 1
                    assert point["value"] == pytest.approx(reference[index], rel=0, abs=1e-9)
            earlier = read({**query, "before": 4101 * 60000})
            for left, right in zip(earlier["indicators"], page["indicators"]):
                indexed = {p["time"]: p["value"] for p in left["series"][0]["values"]}
                overlap = [p for p in right["series"][0]["values"] if p["time"] in indexed]
                assert len(overlap) == 300
                assert all(p["value"] == indexed[p["time"]] for p in overlap)
            with database.begin() as db:
                db.add_all(
                    [
                        Bar(
                            instrument_id="BTCUSDT",
                            timeframe="M1",
                            start=(i + 1) * 60000,
                            end=(i + 2) * 60000,
                            open=closes[i],
                            high=closes[i] + 1,
                            low=closes[i] - 1,
                            close=closes[i],
                            complete=True,
                        )
                        for i in range(6000, 6200)
                    ]
                )
            appended = read(query)
            assert appended["indicators"] == page["indicators"], (
                "Future bars must not change historical indicators"
            )
            first = read({**query, "before": 520 * 60000, "limit": 519})
            warmup = first["indicators"][0]["series"][0]["values"]
            assert all(p["value"] is None for p in warmup[:499])
            assert warmup[499]["value"] == pytest.approx(ema[499], rel=0, abs=1e-9)
    finally:
        api_module.app.dependency_overrides.clear()


def test_indicator_cpu_work_releases_database_connection(database, monkeypatch):
    from alerts import chart_api
    from sqlalchemy import event

    with database.begin() as db:
        engine = db.get_bind()
        for index in (1, 3):
            db.add(Bar(instrument_id='BTCUSDT', timeframe='M1', start=index*60000,
                       end=(index+1)*60000, open=10, high=11, low=9, close=10,
                       complete=True))
    chart_api._CACHE.clear()
    chart_api._RESULT_CACHE.clear()
    checked_out = 0
    probes = []

    def checkout(*args):
        nonlocal checked_out
        checked_out += 1

    def checkin(*args):
        nonlocal checked_out
        checked_out -= 1

    for name in ('bucket_has_trading', 'calculate', 'future_grid'):
        original = getattr(chart_api, name)

        def wrapped(*args, _name=name, _original=original, **kwargs):
            assert checked_out == 0, f'{_name} retained the database connection'
            probes.append(_name)
            return _original(*args, **kwargs)

        monkeypatch.setattr(chart_api, name, wrapped)
    event.listen(engine, 'checkout', checkout)
    event.listen(engine, 'checkin', checkin)
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: 'test'
    try:
        with TestClient(api_module.app) as client:
            result = client.post('/api/charts/data', json={
                'instrument': 'BTCUSDT', 'timeframe': 'M1', 'track_history': True,
                'indicators': [{'name': 'SMA', 'params': {'period': 2}}]})
            assert result.status_code == 200
            assert result.json()['history_check']
        assert set(probes) == {'bucket_has_trading', 'calculate', 'future_grid'}
    finally:
        event.remove(engine, 'checkout', checkout)
        event.remove(engine, 'checkin', checkin)
        api_module.app.dependency_overrides.clear()
