from decimal import Decimal

import pytest
from alerts.chart_alert_geometry import GeometryQuery, geometry
from alerts.chart_alert_worker import geometry_indices
from alerts.chart_data import future_grid
from alerts.storage import Bar, Instrument
from test_chart_alert_worker import config, seed


def query(kind="trend_line", **changes):
    return GeometryQuery.model_validate({
        "instrument": "BTCUSDT", "source": "binance", "series_kind": "managed",
        "timeframe": "M1", "kind": kind,
        "points": [{"time": 0, "price": "9"}, {"time": 120_000, "price": "11"}],
        **changes,
    })


def test_mapping_uses_actual_bars_and_rejects_missing_endpoint(database):
    with database.begin() as db:
        seed(db, [9, 10, 11], absent=1)
        line = geometry(db, query(), now=180_000)
        assert [p["index"] for p in line["points"]] == [0, 1]
        with pytest.raises(ValueError, match="端点未匹配"):
            geometry(db, query(points=[{"time": 60_000, "price": 9}, {"time": 120_000, "price": 11}]), now=180_000)


def test_future_endpoint_mapping_remains_stable_when_actual_bars_arrive(database):
    from alerts.chart_alert_domain import Line

    with database.begin() as db:
        seed(db, [9, 10, 11])
        line = Line.model_validate(geometry(db, query(points=[
            {"time": 60_000, "price": 9}, {"time": 300_000, "price": 11},
        ]), now=180_000))
        assert [p.index for p in line.points] == [0, 4]
        rows = [{"start": i * 60_000, "end": (i + 1) * 60_000} for i in range(3)]
        assert geometry_indices(rows, line, meta={"calendar": "utc0"}, config=config()) == [-1, 0, 1]
        rows += [{"start": i * 60_000, "end": (i + 1) * 60_000} for i in range(3, 6)]
        assert geometry_indices(rows, line, meta={"calendar": "utc0"}, config=config()) == [-1, 0, 1, 2, 3, 4]


def test_weekend_future_slots_follow_forex_calendar(database):
    from datetime import datetime, timezone

    with database.begin() as db:
        instrument = db.get(Instrument, "EURUSD")
        friday = int(datetime(2026, 10, 2, 20, tzinfo=timezone.utc).timestamp() * 1000)
        db.add(Bar(instrument_id="EURUSD", timeframe="H1", start=friday, end=friday+3_600_000,
                   open=Decimal(1), high=Decimal(1), low=Decimal(1), close=Decimal(1), complete=True))
        db.flush()
        slots = future_grid(instrument, "H1", friday+3_600_000, 4)
        line = geometry(db, query(instrument="EURUSD", source=instrument.source, timeframe="H1", points=[
            {"time": friday, "price": 1}, {"time": slots[3]["start"], "price": 2},
        ]), now=friday+3_600_000)
        assert line["points"][1]["index"] == 4
        assert slots[3]["start"]-friday > 4*3_600_000


def test_geometry_rejects_source_mismatch_and_wrong_point_count(database):
    with database.begin() as db:
        seed(db, [9, 10, 11])
        with pytest.raises(ValueError, match="身份不匹配"):
            geometry(db, query(source="oanda"))
        with pytest.raises(ValueError, match="端点数量"):
            geometry(db, query(kind="horizontal_line"))
        value = geometry(db, query(kind="horizontal_line", points=[{"time": 42, "price": 10}]))
        assert value["points"][0]["index"] == 0


def test_authenticated_geometry_and_capability_api(database, monkeypatch):
    from alerts import api as api_module
    from fastapi.testclient import TestClient
    from test_chart_alert_api import login

    with database.begin() as db:
        seed(db, [9, 10, 11])
    with TestClient(api_module.app) as client:
        assert client.post("/api/chart-alerts/geometry", json=query().model_dump(mode="json")).status_code == 401
        login(client, monkeypatch)
        capabilities = client.post("/api/chart-alerts/capabilities", json={
            "instrument": "BTCUSDT", "series_kind": "managed", "timeframe": "M1",
        })
        assert capabilities.status_code == 200
        assert capabilities.json()["sources"][0]["available"]
        response = client.post("/api/chart-alerts/geometry", json=query().model_dump(mode="json"))
        assert response.status_code == 200 and response.json()["points"][1]["index"] == 2


def test_timeframe_remapping_keeps_saved_drawing_monitoring(database, monkeypatch):
    from alerts import api as api_module
    from alerts.chart_alert_worker import evaluate
    from alerts.storage import ChartAlert
    from fastapi.testclient import TestClient
    from test_chart_alert_api import login

    with database.begin() as db:
        for frame, step, count in (("H1", 3_600_000, 8), ("H4", 14_400_000, 3)):
            for index in range(count):
                db.add(Bar(instrument_id="BTCUSDT", timeframe=frame,
                           start=index * step, end=(index + 1) * step,
                           open=Decimal(11), high=Decimal(11), low=Decimal(11),
                           close=Decimal(11), complete=True))
    with TestClient(api_module.app) as client:
        login(client, monkeypatch)
        points = [{"time": 0, "price": "10"}, {"time": 14_400_000, "price": "12"}]
        original = client.post("/api/chart-alerts/geometry", json=query(
            timeframe="H1", points=points, extend_right=True).model_dump(mode="json"))
        mapped = client.post("/api/chart-alerts/geometry", json=query(
            timeframe="H4", points=points, extend_right=True).model_dump(mode="json"))
        assert original.status_code == mapped.status_code == 200
        assert [point["index"] for point in original.json()["points"]] == [0, 4]
        assert [point["index"] for point in mapped.json()["points"]] == [0, 1]
        for name, line, expected in (("old", original.json(), "blocked"),
                                     ("remapped", mapped.json(), "ready")):
            cfg = config(timeframe="H4", condition={"relation": "cross_up",
                         "right": {"kind": "line", "line": line}})
            saved = client.post("/api/chart-alerts", json={
                "request_id": name, "config": cfg.model_dump(mode="json")})
            if name == "old":
                assert saved.status_code == 422
                continue
            assert saved.status_code == 201, saved.text
            with database.begin() as db:
                evaluate(db, saved.json()["id"], now=43_200_001)
                assert db.get(ChartAlert, saved.json()["id"]).health == expected


def test_managed_daily_points_use_native_trading_date_labels(database):
    from datetime import datetime, timezone

    from alerts.chart_labels import managed_label
    from alerts.domain import Calendar, session_bounds
    from alerts.storage import ms

    with database.begin() as db:
        instrument = db.get(Instrument, "EURUSD")
        moments = [datetime(2026, 10, day, 12, tzinfo=timezone.utc) for day in (1, 2)]
        rows = []
        for at in moments:
            start, end = session_bounds(at, Calendar.NY17)
            row = {"start": ms(start), "end": ms(end)}
            rows.append(row)
            db.add(Bar(instrument_id="EURUSD", timeframe="D1", start=row["start"], end=row["end"],
                       open=Decimal(1), high=Decimal(1), low=Decimal(1), close=Decimal(1), complete=True))
        db.flush()
        points = [{"time": managed_label(row, "D1", "EURUSD"), "price": 1+i} for i, row in enumerate(rows)]
        assert points[0]["time"] != rows[0]["start"]
        value = geometry(db, query(instrument="EURUSD", source=instrument.source, timeframe="D1", points=points), now=rows[-1]["end"])
        assert [point["index"] for point in value["points"]] == [0, 1]
