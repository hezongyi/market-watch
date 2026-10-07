import pytest
from alerts import api as api_module
from alerts.history_artifacts import artifact_tick, request_artifacts
from alerts.history_replay import create_replay
from alerts.history_versions import import_page
from alerts.storage import Replay
from fastapi.testclient import TestClient
from test_history_versions import Adapter, create
from test_market_contracts import batch, minute


def finish_periods(database, ident, frames=("M1", "D1")):
    from alerts.storage import HistoryVersion

    with database.begin() as db:
        request_artifacts(db, db.get(HistoryVersion, ident), list(frames))
    while artifact_tick(ident):
        pass


def test_pinned_replay_inputs_and_manifest_survive_new_history_version(database):
    first, instrument = create(database)
    import_page(Adapter([batch(checkpoint=120000)]), version_id=first)
    finish_periods(database, first)
    with database.begin() as db:
        from alerts.storage import Instrument

        run = create_replay(db, db.get(Instrument, instrument), first, "M1", 0, 120000)
        saved, original = run.id, run.bars
        manifest = run.input_manifest
    second, _ = create(database)
    import_page(Adapter([batch(rows=(minute(close="1.10"), minute(60000, close="1.10")),
                              observed_at=185000, checkpoint=120000)]), version_id=second)
    with database.begin() as db:
        run = db.get(Replay, saved)
        assert run.dataset_version == first
        assert run.bars == original and run.input_manifest == manifest


def test_api_requires_explicit_version_and_seek_preserves_source_provenance(database):
    first, instrument = create(database)
    import_page(Adapter([batch(checkpoint=120000)]), version_id=first)
    finish_periods(database, first)
    body = {"instrument_id": instrument, "timeframe": "M1", "start": 0, "end": 120000}
    api_module.app.dependency_overrides[api_module.authenticated] = lambda: "test"
    try:
        with TestClient(api_module.app) as client:
            assert client.post("/api/replays", json=body).status_code == 422
            response = client.post("/api/replays", json=body | {"dataset_version": first})
            assert response.status_code == 201
            replay = response.json()
            assert replay["dataset_version"] == first
            assert replay["input_manifest"]["identity"]["channel"] == "python"
            seek = client.post("/api/replays/" + replay["id"] + "/seek", json={"cursor": 60000})
            assert seek.status_code == 201
            assert seek.json()["input_manifest"] == replay["input_manifest"]
            assert seek.json()["dataset_version"] == first
            watch = client.post("/api/replays/" + replay["id"] + "/watches", json={
                "instrument_id": instrument, "name": "source pinned", "kind": "price",
                "timeframe": "M1", "level": "1.105", "direction": "buy",
            })
            assert watch.status_code == 200
            assert client.get("/api/market-data/versions/" + first).json()["status"] == "published"
            assert client.post("/api/imports", json=body).status_code == 422
    finally:
        api_module.app.dependency_overrides.clear()


@pytest.mark.parametrize("frame", ["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN"])
def test_replay_reads_exact_closed_chart_artifacts_without_raw_m1(database, monkeypatch, frame):
    import alerts.history_artifacts as artifacts
    from alerts.storage import HistoryVersion, Instrument, MarketDemand
    from sqlalchemy import select
    end = 65 * 86400000
    # Sparse observed prices keep unknown coverage explicit across week/month,
    # rather than fabricating all 93,600 missing minute prices.
    ident, instrument = create(database, end=end)

    class SparseSource:
        def page(self, identity, start, stop):
            return batch(window_start=start, window_end=stop, checkpoint=stop, observed_at=stop + 5000,
                rows=tuple(minute(at) for at in range(start, stop, 86400000)))

    while import_page(SparseSource(), version_id=ident):
        pass
    finish_periods(database, ident, frames=(frame, "D1"))
    def forbidden(*args, **kwargs):
        raise AssertionError("Replay attempted raw M1 aggregation")
    monkeypatch.setattr(artifacts, "raw_chunk", forbidden)
    with database.begin() as db:
        expected = [row for row in artifacts.read_artifact(db, ident, frame, limit=20000) if row["end"] <= end]
        run = create_replay(db, db.get(Instrument, instrument), ident, frame, 0, end)
        assert run.bars == [{**row, "revision": 1} for row in expected]
        assert all(row["end"] <= end for row in run.bars + run.days)
        assert run.input_manifest["period_artifacts"][frame]["parent_checksum"] == db.get(HistoryVersion, ident).manifest["checksum"]
        assert run.input_manifest["period_artifacts"][frame]["checksum"]
        assert db.scalar(select(MarketDemand)) is None
        if frame != "M1":
            assert all(not row["complete"] and not row["coverage_complete"] for row in run.bars)


def test_replay_pending_periods_are_rejected_without_synchronous_aggregation(database):
    from alerts.storage import Instrument, MarketDemand
    from sqlalchemy import select

    first, instrument = create(database)
    import_page(Adapter([batch(checkpoint=120000)]), version_id=first)
    with database.begin() as db:
        with pytest.raises(ValueError, match="M1.*尚未发布"):
            create_replay(db, db.get(Instrument, instrument), first, "M1", 0, 120000)
        assert db.scalar(select(Replay)) is None
        assert db.scalar(select(MarketDemand)) is None
    finish_periods(database, first, frames=("M1",))
    with database.begin() as db:
        with pytest.raises(ValueError, match="D1.*尚未发布"):
            create_replay(db, db.get(Instrument, instrument), first, "M1", 0, 120000)


def test_unknown_period_retains_confirmation_and_pauses_simulated_judgment(database):
    from alerts.service import add_replay_watch, replay_step
    from alerts.storage import Instrument

    first, instrument = create(database, end=600000)
    import_page(Adapter([batch(window_end=600000, rows=(minute(), minute(60000)), checkpoint=600000,
                              observed_at=605000)]), version_id=first)
    finish_periods(database, first, frames=("M5", "D1"))
    with database.begin() as db:
        inst = db.get(Instrument, instrument)
        run = create_replay(db, inst, first, "M5", 0, 600000)
        assert run.bars[-1]["source_confirmed"] and not run.bars[-1]["complete"]
        assert not run.bars[-1]["coverage_complete"]
        add_replay_watch(run, "explicit quality gate", {"kind": "price", "timeframe": "M5",
            "level": "1.105", "direction": "buy"}, inst.calendar, use_history=False)
        replay_step(run, inst.calendar, 2)
        assert run.watches[0]["status"] == "paused"
        assert not run.signals


def test_long_warmup_streams_all_published_blocks_without_twenty_thousand_truncation(database, monkeypatch):
    import alerts.history_artifacts as artifacts
    from alerts.replay_history import history_rows
    from alerts.storage import Instrument
    from test_history_artifacts import publish

    end = 21005 * 60000
    ident, instrument = publish(database, end=end, rows=tuple(minute(at) for at in range(0, end, 60000)))
    finish_periods(database, ident)
    monkeypatch.setattr(artifacts, "raw_chunk", lambda *args: pytest.fail("Raw M1 scanned"))
    with database.begin() as db:
        run = create_replay(db, db.get(Instrument, instrument), ident, "M1", end - 2 * 60000, end)
        assert run.warmup_count == 21003
        assert len(list(history_rows(run))) == 21003
        assert len(run.bars) == 502
        assert run.bars[-1]["end"] == end
