"""Replay stored real supplier M1 through fixed composites in an owned PG schema.

No supplier downloads, normal-composite changes, stream demand or fake prices.
Schema rows are explicit bounded historical test fixtures, not first-use/live
acceptance. Public HTTP publications are independently rechecked before replay.
"""

import argparse
import copy
import json
import uuid
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

import httpx
from alerts import storage
from alerts.composite_aggregates import aggregate_tick, request
from alerts.composite_chart import chart_page
from alerts.composite_definitions import RULES, save_mapping
from alerts.composite_inputs import rows as tail_rows
from alerts.composite_preparation import claim, commit
from alerts.history_versions import snapshot_rows
from alerts.market_contracts import CandleBatch, DatasetIdentity, MinuteRow, RequestResult
from alerts.source_registry import collection_identity
from alerts.storage import (
    CompositePreparation,
    CompositeRevision,
    HistoryArtifact,
    HistoryArtifactBlock,
    HistoryChunk,
    HistoryVersion,
    Instrument,
    MarketCatalog,
    MarketComposite,
    MarketDataset,
    MarketDemand,
    SourceBlob,
    SourceSeries,
    now_ms,
    transaction,
)
from sqlalchemy import create_engine, func, select, text
from sqlalchemy.orm import sessionmaker
from verify_history_calendar_samples import FRAMES, check_prices, reference_bucket

SEAMS = {
    "ny17": {"spring": "2026-03-06T22:00:00+00:00", "autumn": "2025-11-03T22:00:00+00:00",
             "month": "2026-09-01T21:00:00+00:00"},
    "utc0": {"spring": "2026-03-07T00:00:00+00:00", "autumn": "2025-10-31T00:00:00+00:00",
             "month": "2026-09-02T00:00:00+00:00"},
}


def calendar_witnesses(bars, frame, phase, window):
    if phase == "ny17" and window in ("spring", "autumn"):
        if frame == "D1":
            assert {datetime.fromtimestamp(b["start"] / 1000, UTC).hour for b in bars} == {21, 22}
        if frame == "W1":
            hours = 167 if window == "spring" else 169
            assert any(b["end"] - b["start"] == hours * 3600000 for b in bars)
    if frame == "MN" and window == "month":
        assert len(bars) == 2


def capture(samples):
    """Read immutable observations/content from public; never write public rows."""
    cloned, originals, observations = {}, {}, {}
    models = (Instrument, SourceSeries, MarketDataset, SourceBlob, HistoryVersion,
              HistoryChunk, HistoryArtifact, HistoryArtifactBlock, MarketCatalog)

    def take(model, row):
        if row is None:
            raise AssertionError("Missing stored real supplier dependency: " + model.__name__)
        values = {c.name: copy.deepcopy(getattr(row, c.name)) for c in model.__table__.columns}
        cloned.setdefault(model, {})[tuple(values[c.name] for c in model.__table__.primary_key)] = values
        return row

    with transaction() as db:
        demand = db.scalar(select(func.count()).select_from(MarketDemand))
        for sample in samples:
            for phase, ident in (("ny17", sample["version_id"]), ("utc0", sample["utc_version_id"])):
                v = take(HistoryVersion, db.get(HistoryVersion, ident))
                assert v.status == "published"
                d = take(MarketDataset, db.get(MarketDataset, v.dataset_id))
                take(Instrument, db.get(Instrument, d.instrument_id))
                originals[ident] = copy.deepcopy(v.manifest)
                chunks = list(db.scalars(select(HistoryChunk).where(HistoryChunk.version_id == ident)))
                assert chunks
                for chunk in chunks:
                    take(HistoryChunk, chunk)
                    if chunk.content_id:
                        blob = take(SourceBlob, db.get(SourceBlob, chunk.content_id))
                        take(SourceSeries, db.get(SourceSeries, blob.source_id))
                observations[ident] = {"rows": list(snapshot_rows(db, ident)),
                    "observed_at": max(c.observed_at for c in chunks), "identity": d.identity}
                for a in db.scalars(select(HistoryArtifact).where(HistoryArtifact.version_id == ident)):
                    take(HistoryArtifact, a)
                    for b in db.scalars(select(HistoryArtifactBlock).where(HistoryArtifactBlock.artifact_id == a.id)):
                        take(HistoryArtifactBlock, b)
        for symbol in ("EUR_USD", "XAU_USD"):
            entries = list(db.scalars(select(MarketCatalog).where(MarketCatalog.source == "oanda",
                                                                 MarketCatalog.symbol == symbol)))
            assert entries
            for entry in entries:
                take(MarketCatalog, entry)
    return models, cloned, originals, observations, demand


def public_checks(samples):
    result = []
    with httpx.Client(base_url="http://127.0.0.1:8000", timeout=60, trust_env=False) as client:
        client.post("/api/login", json=json.loads(Path(
            "artifacts/data-integration/three-layer-login.json").read_text())).raise_for_status()
        for sample in samples:
            for phase, ident in (("ny17", sample["version_id"]), ("utc0", sample["utc_version_id"])):
                def bars(frame):
                    response = client.get(f"/api/market-data/versions/{ident}/bars",
                                          params={"timeframe": frame, "limit": 20000})
                    response.raise_for_status()
                    return response.json()["bars"]
                minutes, checks = bars("M1"), []
                for frame in FRAMES[1:]:
                    values = bars(frame)
                    checks.append(check_prices(minutes, values, frame, phase))
                    calendar_witnesses(values, frame, phase, sample["window"])
                result.append({"source": sample["source"], "symbol": sample["symbol"],
                    "window": sample["window"], "phase": phase, "version_id": ident,
                    "m1_rows": len(minutes), "checks": checks, "passed": True})
    return result


def replay(db, sample, target_sample, phase, observations, proof):
    ident = sample["version_id"] if phase == "ny17" else sample["utc_version_id"]
    v = db.get(HistoryVersion, ident)
    historical = db.get(MarketDataset, v.dataset_id)
    entry = db.scalar(select(MarketCatalog).where(MarketCatalog.source == "oanda",
        MarketCatalog.symbol == target_sample["symbol"][:3] + "_USD"))
    mapping = save_mapping(db, historical.id, entry.id, proof)
    target = db.get(MarketDataset, mapping.target_dataset_id)
    assert collection_identity(target.identity) == collection_identity(observations[target_sample["version_id"]]["identity"])
    seam = int(datetime.fromisoformat(SEAMS[phase][sample["window"]]).timestamp() * 1000)
    assert v.start < seam < v.end
    rules = {**RULES, "aggregation_calendar": phase,
             "historical_calendar_version": historical.identity["calendar_version"]}
    key = uuid.uuid4().hex
    inst = Instrument(id="cal:" + key, label=sample["symbol"], source="composite",
        symbol=sample["symbol"], calendar=phase, precision=5, enabled=False)
    db.add(inst)
    db.flush()
    c = MarketComposite(id=key, instrument_id=inst.id, dataset_id=historical.id,
        mapping_id=mapping.id, permission_scope="workspace:default", rules=rules)
    db.add(c)
    db.flush()
    r = CompositeRevision(composite_id=c.id, history_version_id=v.id, mapping_id=mapping.id,
        seam=seam, rules=rules, request_id="bounded-stored-real-supplier-calendar-replay")
    db.add(r)
    db.flush()
    c.active_revision_id = r.id
    db.add(CompositePreparation(revision_id=r.id, cursor=seam, cutoff=v.end,
        state={"acceptance_fixture": "stored real M1; bounded historical cutoff; no live first-use"}))
    db.flush()
    request(db, r.id)
    return c.id, r.id, target.identity, seam


def verify_case(composite_id, revision_id, sample, target_sample, phase, observations, target_identity, seam):
    target_data = observations[target_sample["version_id"]]
    while ownership := claim(revision_id):
        actual = tuple(MinuteRow.model_validate(row) for row in target_data["rows"]
                       if ownership["start"] <= row["timestamp"] < ownership["end"])
        commit(ownership, CandleBatch(identity=DatasetIdentity.model_validate(target_identity),
            window_start=ownership["start"], window_end=ownership["end"],
            checkpoint=ownership["end"], observed_at=target_data["observed_at"],
            result=RequestResult(status="data" if actual else "empty_success"),
            volume_kind="price_count", volume_unit="quotes", rows=actual),
            read_kind="stored_supplier_replay")
    ticks = 0
    while aggregate_tick(revision_id):
        ticks += 1
        assert ticks < 1000, "Aggregation did not reach fixed input"
    checks = []
    with transaction() as db:
        r, p = db.get(CompositeRevision, revision_id), db.get(CompositePreparation, revision_id)
        v = db.get(HistoryVersion, r.history_version_id)
        assert p.status == "queried" and p.cursor == v.end
        history = list(snapshot_rows(db, v.id, start=v.start, end=seam))
        tail = list(tail_rows(db, r.id, seam, v.end, input_revision=p.input_revision))
        raw_tail = [row for row in target_data["rows"] if seam <= row["timestamp"] < v.end]
        fields = ("timestamp", "open", "high", "low", "close", "volume")
        def price_tuple(row):
            return (row["timestamp"], *(None if row[k] is None else Decimal(row[k]) for k in fields[1:]))
        assert [price_tuple(row) for row in tail] == [price_tuple(row) for row in raw_tail]
        assert history and tail
        minutes = history + tail
        for frame in FRAMES[1:]:
            page = chart_page(db, composite_id, frame, revision_id=r.id,
                input_revision=p.input_revision, before=v.end, count=2000, now=now_ms())
            assert page["materialized"] and not page["pending"]
            groups = {}
            for row in minutes:
                groups.setdefault(reference_bucket(row["timestamp"], frame, phase), []).append(row)
            assert len(page["bars"]) == len(groups)
            mixed = unknown = 0
            for bar in page["bars"]:
                members = groups[(bar["start"], bar["end"])]
                expected = (Decimal(members[0]["open"]), max(Decimal(m["high"]) for m in members),
                    min(Decimal(m["low"]) for m in members), Decimal(members[-1]["close"]))
                assert tuple(Decimal(bar[k]) for k in ("open", "high", "low", "close")) == expected
                assert bar["observed_minutes"] == len(members) and bar["source_confirmed"]
                if bar["start"] >= reference_bucket(seam, frame, phase)[0]:
                    assert bar["confirmed_closed_minutes"] == 0
                    assert bar["unknown_minutes"] == (bar["end"] - bar["start"]) // 60000 - len(members)
                    unknown += bar["unknown_minutes"]
                selected_sources = {"history" if m["timestamp"] < seam else "target" for m in members}
                if len(selected_sources) == 2:
                    assert bar["mixed_source"] and bar["seam_crossing"] and bar["volume"] is None
                    assert bar["volume_kind"] == "unavailable" and not bar["volume_complete"]
                    for segment in bar["segments"]:
                        selected = [m for m in members if (m["timestamp"] < seam) == (segment["segment"] == "history")]
                        assert segment["observed_minutes"] == len(selected)
                        assert Decimal(segment["observed_volume"]) == sum(Decimal(m["volume"]) for m in selected)
                    mixed += 1
            calendar_witnesses(page["bars"], frame, phase, sample["window"])
            # A Friday NY17 seam falls after the last observed market minute;
            # DST-week W1 may have no target observations before Sunday. Keep
            # that absence explicit; monthly buckets still witness both sources.
            if frame == "MN":
                assert mixed, (phase, sample["window"], frame, "no mixed source witness")
            checks.append({"frame": frame, "buckets": len(page["bars"]), "mixed_buckets": mixed,
                "tail_unknown_minutes": unknown, "independent_ohlc_matches": True})
        return {"symbol": sample["symbol"], "window": sample["window"], "phase": phase,
            "history_version_id": v.id, "target_observations_version_id": target_sample["version_id"],
            "seam": seam, "cutoff": v.end, "history_rows": len(history), "target_rows": len(tail),
            "input_revision": p.input_revision, "aggregation_ticks": ticks, "checks": checks, "passed": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    samples = json.loads(args.input.read_text())["records"]
    report = {"environment": "Ubuntu market-watch-three-layer PostgreSQL; isolated replay schema",
        "passed": False, "records": [], "schema_removed": False,
        "meaning": "Actual stored supplier prices through production preparation/input/aggregation/chart code. Explicit bounded historical fixtures; not live first-use or 48h quality acceptance."}
    models, cloned, originals, observations, demand = capture(samples)
    report["public_http_calendar_checks"] = public_checks(samples)
    setup = json.loads(Path("artifacts/data-integration/cross-source-setup.json").read_text())
    proofs = {r["symbol"]: r["match"] for r in setup["records"]}
    schema = "calendar_replay_" + uuid.uuid4().hex
    admin = create_engine(storage.settings.database_url, pool_size=1, max_overflow=0)
    isolated = create_engine(storage.settings.database_url, pool_size=2, max_overflow=0,
        connect_args={"options": f"-csearch_path={schema}"})
    original_session = storage.Session
    with admin.begin() as conn:
        conn.execute(text(f"CREATE SCHEMA {schema}"))
    try:
        storage.Base.metadata.create_all(isolated)
        storage.Session = sessionmaker(isolated, expire_on_commit=False)
        with transaction() as db:
            for model in models:
                db.add_all(model(**values) for values in cloned.get(model, {}).values())
                db.flush()
        for sample in (s for s in samples if s["source"] == "dukascopy"):
            target = next(s for s in samples if s["source"] == "oanda" and
                          (s["symbol"], s["window"]) == (sample["symbol"], sample["window"]))
            for phase in ("ny17", "utc0"):
                with transaction() as db:
                    comp, rev, identity, seam = replay(db, sample, target, phase, observations, proofs[sample["symbol"]])
                result = verify_case(comp, rev, sample, target, phase, observations, identity, seam)
                report["records"].append(result)
                print(json.dumps({k: result[k] for k in ("symbol", "window", "phase", "passed")}), flush=True)
        with transaction() as db:
            assert db.scalar(select(func.count()).select_from(MarketDemand)) == 0
            assert all(db.get(HistoryVersion, ident).manifest == manifest for ident, manifest in originals.items())
        report.update(passed=True, no_demand_created=True, stored_original_manifests_unchanged=True)
    finally:
        storage.Session = original_session
        isolated.dispose()
        with admin.begin() as conn:
            conn.execute(text(f"DROP SCHEMA {schema} CASCADE"))
        admin.dispose()
        report["schema_removed"] = True
        with transaction() as db:
            assert db.scalar(select(func.count()).select_from(MarketDemand)) == demand
            assert all(db.get(HistoryVersion, ident).manifest == manifest for ident, manifest in originals.items())
        args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"passed": report["passed"], "records": len(report["records"]),
                      "public_checks": len(report["public_http_calendar_checks"]), "schema_removed": True}))


if __name__ == "__main__":
    main()
