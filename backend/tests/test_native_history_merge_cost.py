"""Single checkpoint decode and immutable block inheritance across many months."""

from alerts import native_history_archive as archive
from alerts.history_maintenance import create_run
from alerts.source_history_store import raw_chunk
from alerts.storage import HistoryChunk, HistoryVersion
from sqlalchemy import select
from test_history_modes import native_bar
from test_native_history_archive import Adapter, day, drain, prepare, run, stamp


def test_checkpoint_pages_decode_once_and_inherited_period_is_not_reencoded(database, monkeypatch):
    dataset = prepare(database, mode="native_periods", outputs=("D1", "M5"))
    days = [day(f"{year}-{month:02}-02") for year in (2024, 2025) for month in range(1, 13)]
    minute = native_bar(timeframe="M5", start=stamp("2025-12-02"), end=stamp("2025-12-02") + 300000)
    reads = []
    original = archive._rows_from_pages
    def decoded(db, frame):
        reads.extend(frame.facts.get("pages", []))
        yield from original(db, frame)
    monkeypatch.setattr(archive, "_rows_from_pages", decoded)
    first = run(database, dataset, "2026-01-01", Adapter({"D1": days, "M5": [minute]}))
    assert len(reads) == len(set(reads)) == 2
    with database.begin() as db:
        old_chunks = list(db.scalars(select(HistoryChunk).where(HistoryChunk.version_id == first, HistoryChunk.timeframe == "D1")))
        old_contents = sorted((chunk.start, chunk.checksum, chunk.content_id) for chunk in old_chunks)
        second = create_run(db, dataset, end=stamp("2026-01-02"), request_id="partial", requested_frames=["M5"]).id
    stored = []
    save = archive.store_blob
    def stored_blob(db, source_id, raw):
        stored.append(source_id)
        return save(db, source_id, raw)
    monkeypatch.setattr(archive, "store_blob", stored_blob)
    drain(second, Adapter({"M5": [minute]}))
    with database() as db:
        version = db.get(HistoryVersion, second)
        inherited = list(db.scalars(select(HistoryChunk).where(HistoryChunk.version_id == second, HistoryChunk.timeframe == "D1")))
        assert sorted((chunk.start, chunk.checksum, chunk.content_id) for chunk in inherited) == old_contents
        assert version.manifest["frames"]["D1"]["source_id"] not in stored
        assert version.manifest["frames"]["D1"]["rows"] == 24
        for chunk in inherited:
            assert raw_chunk(db, chunk)


def test_unordered_corrections_across_staging_groups_match_ordered_oracle(database, monkeypatch):
    import json
    from types import SimpleNamespace

    from alerts.storage import HistoryFrameRun

    dataset = prepare(database, mode="native_periods", outputs=("D1",))
    first = run(database, dataset, "2026-01-01", Adapter({"D1": [
        day("2024-01-02"), day("2024-02-02"), day("2025-12-02")]}))
    with database.begin() as db:
        original = [row for chunk in db.scalars(select(HistoryChunk).where(
            HistoryChunk.version_id == first).order_by(HistoryChunk.start)) for row in json.loads(raw_chunk(db, chunk))]
        incoming = [{**original[1], "close": "10"}, *[dict(original[-1]) for _ in range(4100)],
            original[1], {**original[0], "close": "10"}, {**original[1], "close": "10.5"}]
        expected = {row["start"]: row for row in original}
        changed = None
        for row in incoming:
            if expected.get(row["start"]) != row:
                changed = row["start"] if changed is None else min(changed, row["start"])
            expected[row["start"]] = row
        frame = db.get(HistoryFrameRun, (first, "D1"))
        second = create_run(db, dataset, end=stamp("2026-01-02"), request_id="unordered").id
        monkeypatch.setattr(archive, "_rows_from_pages", lambda *_: iter(incoming))
        facts = archive._merge(db, SimpleNamespace(id=second), SimpleNamespace(
            inherited_version_id=first, timeframe="D1", source_id=frame.source_id, observed_at=1))
        db.flush()
        output = [row for chunk in db.scalars(select(HistoryChunk).where(
            HistoryChunk.version_id == second).order_by(HistoryChunk.start)) for row in json.loads(raw_chunk(db, chunk))]
        assert output == sorted(expected.values(), key=lambda row: row["start"])
        assert facts == {"rows": len(output), "first": output[0]["start"], "last": output[-1]["end"], "changed_from": changed}


def test_inherited_refs_are_revalidated_before_publication(database, monkeypatch):
    import pytest
    from alerts.history_versions import import_page

    dataset = prepare(database, mode="native_periods", outputs=("D1", "M5"))
    m5 = native_bar(timeframe="M5", start=stamp("2025-12-02"), end=stamp("2025-12-02") + 300000)
    first = run(database, dataset, "2026-01-01", Adapter({"D1": [day("2025-12-02")], "M5": [m5]}))
    with database.begin() as db:
        second = create_run(db, dataset, end=stamp("2026-01-02"), request_id="corrupt-ref", requested_frames=["M5"]).id
    original = archive.raw_chunk
    def checked(db, chunk):
        if chunk.timeframe == "D1" and chunk.version_id == second:
            raise ValueError("inherited checksum mismatch")
        return original(db, chunk)
    monkeypatch.setattr(archive, "raw_chunk", checked)
    adapter = Adapter({"M5": [m5]})
    with pytest.raises(ValueError, match="inherited checksum"):
        for _ in range(10):
            import_page(adapter, version_id=second)
    with database() as db:
        assert db.get(HistoryVersion, second).status != "published"
        assert db.get(HistoryVersion, first).status == "published"
