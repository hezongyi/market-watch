"""A concurrent baseline source must never publish a temporary default price."""

import importlib.util
from pathlib import Path

from alerts.storage import CompositeRevision, LiveState, RealtimeMapping
from sqlalchemy import event
from test_composite_alerts import continuous

spec = importlib.util.spec_from_file_location(
    "runtime_baseline", Path(__file__).resolve().parents[2] / "scripts/runtime_market_baseline.py")
baseline = importlib.util.module_from_spec(spec)
spec.loader.exec_module(baseline)


def test_source_quote_has_one_coherent_commit(database, monkeypatch):
    _, revision, _, stamp = continuous(database, monkeypatch)
    with database() as db:
        target = db.get(RealtimeMapping, db.get(CompositeRevision, revision).mapping_id).target_dataset_id
    observations = []

    def observe_commit(session):
        # A separate reader sees every committed source state, including a
        # temporary default price if a test helper writes it in two phases.
        with database() as reader:
            state = reader.get(LiveState, target)
            observations.append((state.quote["bid"], state.forming.get("close")))

    event.listen(database.class_, "after_commit", observe_commit)
    try:
        baseline.sample_quote(database, revision, stamp // 60000 * 60000, stamp + 2000, "1.119")
    finally:
        event.remove(database.class_, "after_commit", observe_commit)
    assert observations == [("1.119", "1.119")]
