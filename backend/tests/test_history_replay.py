from alerts.history_artifacts import artifact_tick, request_artifacts
from alerts.history_versions import import_page
from alerts.storage import Replay
from legacy_records import create_replay
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


def test_archived_packed_and_legacy_snapshots_decode_with_cutoff(database):
    from types import SimpleNamespace

    from alerts.replay_history import history_rows
    from legacy_records import pack_history

    rows = [{"start": i * 60000, "end": (i+1)*60000, "close": "1.10"} for i in range(21005)]
    packed, count = pack_history(rows[:-2])
    run = SimpleNamespace(warmup_snapshot=packed, warmup_count=count,
                          bars=rows[-502:], start=rows[-3]["end"], cursor=rows[-1]["end"])
    assert list(history_rows(run)) == rows
    assert list(history_rows(run, until=rows[100]["end"])) == rows[:101]
    run.warmup_snapshot = None
    run.bars = rows
    assert list(history_rows(run)) == rows
