"""Sunday candidate shadow evidence never moves a live binding."""

import pytest
from alerts import baseline_shadow, storage, switch_runs
from alerts.chart_alert_service import create as create_alert
from alerts.chart_data import FRAMES
from alerts.composite_inputs import apply_minutes
from alerts.composite_revisions import preparation_tick
from alerts.confirmed_minutes import record
from alerts.fixed_indicators import indicator_tick, request
from alerts.history_artifacts import artifact_tick
from alerts.market_contracts import DatasetIdentity
from alerts.storage import (
    ChartPublication,
    CompositePreparation,
    CompositeRevision,
    HistoryVersion,
    Instrument,
    MarketComposite,
    MarketDataset,
    MarketSwitchRun,
    Preference,
    RealtimeMapping,
)
from sqlalchemy import func, select
from test_composite_aggregates import drain
from test_composite_alerts import config, live
from test_composite_chart import populated
from test_composite_definitions import publish
from test_market_contracts import batch, identity, minute

SMA = {"relation": "cross_up", "left": {"kind": "indicator",
    "indicator": {"name": "SMA", "version": "1", "params": {"period": 3}, "output": "value"}},
    "right": {"kind": "constant", "value": "1.2"}}
EMA = {"relation": "cross_up", "left": {"kind": "indicator",
    "indicator": {"name": "EMA", "version": "1", "params": {"period": 3}, "output": "value"}},
    "right": {"kind": "constant", "value": "1.2"}}
SPEC = {"name": "SMA", "version": "1", "params": {"period": 3}}
NEWER_END = 198960000
STAMP = 200000000


def target_identity(db, revision_id):
    revision = db.get(CompositeRevision, revision_id)
    target = db.get(MarketDataset, db.get(RealtimeMapping, revision.mapping_id).target_dataset_id)
    return DatasetIdentity.model_validate(target.identity)


def confirm(database, revision_id, start, close, *, observed_at, reason):
    with database.begin() as db:
        rows = tuple(minute(at, open=close, high=close, low=close, close=close, volume="3")
                     for at in range(start, start + 5 * 60000, 60000))
        end = start + 5 * 60000
        recorded = record(db, batch(identity=target_identity(db, revision_id), window_start=start,
            window_end=end, checkpoint=end, observed_at=observed_at, rows=rows,
            volume_kind="price_count", volume_unit="quotes"))
        apply_minutes(db, recorded, revision_id=revision_id, reason=reason)


def candidate_fixture(database, monkeypatch, *, settled=True):
    """Active composite, a newer published version and its prepared candidate."""
    monkeypatch.setattr("alerts.composite_revisions.now_ms", lambda: 200010000)
    composite, active, seam = populated(database, monkeypatch)
    publish(database, end=NEWER_END)
    live(database, active, STAMP - 1000, seam + 600000)
    drain(active, "M1")
    with database.begin() as db:
        version = db.get(HistoryVersion, db.get(CompositeRevision, active).history_version_id)
        instrument = db.get(Instrument, db.get(MarketDataset, version.dataset_id).instrument_id)
        db.add(ChartPublication(instrument_id=instrument.id, timeframe="H1", start=0, end=60000,
                                complete_count=2, initialized=True))
    with database.begin() as db:
        captured = create_alert(db, "shadow-sma", config(composite, condition=SMA), at=STAMP).id
    with database.begin() as db:
        plan = baseline_shadow.candidate_plan(db, composite)
        assert plan["version_id"] != db.get(CompositeRevision, active).history_version_id
    candidate = baseline_shadow.create_candidate(composite, plan)
    while artifact_tick(plan["version_id"]):
        pass
    if not settled:
        return composite, active, candidate, plan, (captured,)
    with database.begin() as db:
        prep = db.get(CompositePreparation, candidate)
        prep.status, prep.cursor = "queried", prep.cutoff
    # One fresh confirmation both revisions share, then a candidate-only
    # corrected price: the shadow report must count that difference.
    confirm(database, candidate, plan["seam"], "1.10", observed_at=STAMP, reason="live_confirmation")
    confirm(database, candidate, plan["seam"], "1.30", observed_at=STAMP + 1000, reason="preparation")
    for frame in FRAMES:
        drain(candidate, frame)
        drain(active, frame)
    preparation_tick()
    while indicator_tick():
        pass
    with database.begin() as db:
        current = db.get(CompositePreparation, active)
        request(db, {"revision_id": active,
                     "history_version_id": db.get(CompositeRevision, active).history_version_id,
                     "input_revision": current.input_revision, "timeframe": "M1"}, SPEC)
    while indicator_tick():
        pass
    with database.begin() as db:
        late = create_alert(db, "shadow-ema", config(composite, condition=EMA), at=STAMP).id
    return composite, active, candidate, plan, (captured, late)


def test_report_contains_every_required_shadow_field(database, monkeypatch):
    composite, active, candidate, plan, rules = candidate_fixture(database, monkeypatch)
    report = baseline_shadow.shadow(composite, scheduled_for=STAMP)
    assert report["schema"] == baseline_shadow.SCHEMA
    assert report["status"] == "ready" and report["ready"], report.get("error")
    assert report["history_version"]["candidate_version_id"] == plan["version_id"]
    assert report["history_version"]["latest_available_version_id"] == plan["version_id"]
    assert report["revision"]["candidate_revision_id"] == candidate
    assert report["revision"]["active_revision_id"] == active
    assert report["revision"]["candidate_seam"] == plan["seam"]
    assert [frame["timeframe"] for frame in report["bars"]["frames"]] == list(FRAMES)
    frame = next(item for item in report["bars"]["frames"] if item["timeframe"] == "M1")
    assert frame["target"]["status"] == "compared"
    assert frame["target"]["changed"] == 5 and frame["target"]["added"] == 0
    assert frame["target"]["missing"] == 0
    assert frame["target"]["max_price_delta"] > 0.19
    assert frame["history"]["status"] == "compared" and frame["history"]["same"] > 0
    assert report["gaps"]["scanned"]["observed_minutes"] == 5
    assert [item["segment"] for item in report["gaps"]["uncovered"]] == ["target"]
    indicator = report["indicators"][0]
    assert indicator["candidate"]["has_value"] and indicator["current"]["has_value"]
    assert indicator["difference"]["comparable"] is True
    paused = {rule["alert_id"]: rule for rule in report["paused_rules"]}
    assert paused[rules[0]]["will_pause"] is False
    assert paused[rules[0]]["reasons"] == []
    assert paused[rules[1]]["will_pause"] is True
    assert {reason["code"] for reason in paused[rules[1]]["reasons"]} == {"indicator_missing"}
    run = switch_runs.get(report["run"]["id"])
    assert run["kind"] == baseline_shadow.KIND and run["state"] == "shadow_ready"
    assert run["target_revision_id"] == candidate
    assert run["shadow_report"]["revision"]["candidate_revision_id"] == candidate


def test_live_bindings_are_snapshotted_and_unchanged(database, monkeypatch):
    composite, active, candidate, plan, rules = candidate_fixture(database, monkeypatch)
    before = baseline_shadow.bindings(composite)
    assert len(before["alerts"]) == 2 and before["publications"] and before["alert_versions"]
    report = baseline_shadow.shadow(composite, scheduled_for=STAMP)
    after = baseline_shadow.bindings(composite)
    with database() as db:
        assert db.get(MarketComposite, composite).active_revision_id == active
        assert db.get(CompositeRevision, candidate).activated_at is None
        assert len([row.key for row in db.scalars(select(Preference).where(
            Preference.key.like("managed_realtime:%")))]) == len(before["realtime_preferences"])
    assert after == before
    assert report["bindings"]["critical_unchanged"] is True
    assert report["bindings"]["active_revision_id"] == {"before": active, "after": active,
                                                        "unchanged": True}
    assert all(table["unchanged"] for table in report["bindings"]["tables"].values())


def test_unready_candidate_reports_reasons_without_binding_changes(database, monkeypatch):
    composite, active, candidate, plan, _ = candidate_fixture(database, monkeypatch,
                                                              settled=False)
    before = baseline_shadow.bindings(composite)
    report = baseline_shadow.shadow(composite, scheduled_for=STAMP)
    assert report["status"] == "not_ready" and report["ready"] is False
    codes = {reason["code"] for reason in report["reasons"]}
    assert "preparation_confirming_m1" in codes
    assert baseline_shadow.bindings(composite) == before
    assert report["bindings"]["active_revision_id"]["unchanged"] is True
    run = switch_runs.get(report["run"]["id"])
    assert run["state"] == "failed" and run["phase"] == "shadow_not_ready"
    assert run["shadow_report"]["status"] == "not_ready"
    assert run["error_summary"]["candidate_revision_id"] == candidate


def test_latest_version_beyond_cutoff_is_reported_without_a_candidate(database, monkeypatch):
    composite, active, candidate, plan, _ = candidate_fixture(database, monkeypatch,
                                                              settled=False)
    recent_version(database)
    before = baseline_shadow.bindings(composite)
    report = baseline_shadow.shadow(composite, scheduled_for=STAMP)
    assert report["status"] == "not_ready" and report["ready"] is False
    assert {reason["code"] for reason in report["reasons"]} == {"candidate_beyond_cutoff"}
    assert "revision" not in report and "bars" not in report
    assert baseline_shadow.bindings(composite) == before
    assert report["bindings"]["active_revision_id"]["unchanged"] is True
    run = switch_runs.get(report["run"]["id"])
    assert run["state"] == "failed" and run["phase"] == "shadow_not_ready"
    assert run["shadow_report"]["reasons"][0]["code"] == "candidate_beyond_cutoff"


def test_shadow_failure_is_recorded_not_raised(database, monkeypatch):
    composite, active, candidate, plan, _ = candidate_fixture(database, monkeypatch,
                                                              settled=False)
    monkeypatch.setattr(baseline_shadow, "advance", lambda *args, **kwargs: 1 / 0)
    report = baseline_shadow.shadow(composite, scheduled_for=STAMP)
    assert report["status"] == "failed" and report["ready"] is False
    assert report["error"]["type"] == "ZeroDivisionError"
    assert {reason["code"] for reason in report["reasons"]} == {"shadow_failed"}
    assert report["bindings"]["active_revision_id"]["unchanged"] is True
    run = switch_runs.get(report["run"]["id"])
    assert run["state"] == "failed" and run["shadow_report"]["status"] == "failed"
    assert run["error_summary"]["status"] == "failed"
    assert run["target_revision_id"] == candidate


def test_rerun_reuses_one_run_and_overwrites_its_report(database, monkeypatch):
    composite, active, candidate, plan, _ = candidate_fixture(database, monkeypatch)
    first = baseline_shadow.shadow(composite, scheduled_for=STAMP)
    second = baseline_shadow.shadow(composite, scheduled_for=STAMP)
    assert first["run"]["id"] == second["run"]["id"]
    with database() as db:
        assert db.scalar(select(func.count()).select_from(MarketSwitchRun)) == 1
        run = db.get(MarketSwitchRun, first["run"]["id"])
        assert run.state == "shadow_ready" and run.target_revision_id == candidate
        assert run.shadow_report["revision"]["candidate_revision_id"] == candidate
    with database.begin() as db:
        db.get(CompositePreparation, candidate).status = "pending"
    not_ready = baseline_shadow.shadow(composite, run_id=first["run"]["id"])
    assert not_ready["status"] == "not_ready"
    with database() as db:
        assert db.scalar(select(func.count()).select_from(MarketSwitchRun)) == 1
        assert db.get(MarketSwitchRun, first["run"]["id"]).state == "failed"
    with database.begin() as db:
        prep = db.get(CompositePreparation, candidate)
        prep.status, prep.cursor = "queried", prep.cutoff
    recovered = baseline_shadow.shadow(composite, run_id=first["run"]["id"])
    assert recovered["status"] == "ready" and recovered["run"]["id"] == first["run"]["id"]
    with database() as db:
        assert db.scalar(select(func.count()).select_from(MarketSwitchRun)) == 1
        run = db.get(MarketSwitchRun, first["run"]["id"])
        assert run.state == "shadow_ready" and run.attempts == 1


def recent_version(database):
    """Publish a version ending at wall-clock time so its seam passes the cutoff."""
    from alerts.history_versions import create_version, import_page
    from test_history_versions import Adapter

    end = (storage.now_ms() - 5000) // 60000 * 60000
    start = end - 2 * 86400000
    with database.begin() as db:
        ident = create_version(db, identity().key, start, end)
    import_page(Adapter([batch(window_start=start, window_end=end, checkpoint=end,
                               rows=(minute(end - 60000),))]), version_id=ident)
    while artifact_tick(ident):
        pass
    return ident


def republish(database, end, rows):
    """Publish another fixed version of the same source with explicit prices."""
    from alerts.history_versions import create_version, import_page
    from test_history_versions import Adapter

    with database.begin() as db:
        ident = create_version(db, identity().key, 0, end)
    import_page(Adapter([batch(window_end=end, checkpoint=end, rows=rows)]), version_id=ident)
    while artifact_tick(ident):
        pass
    return ident


def test_rewritten_history_price_is_counted_with_its_delta(database, monkeypatch):
    composite, active, candidate, plan, _ = candidate_fixture(database, monkeypatch,
                                                              settled=False)
    rewritten = tuple(minute(at, open="1.20", high="1.22", low="1.19", close="1.21")
                      for at in (0, 60000, NEWER_END - 120000, NEWER_END - 60000))
    version = republish(database, NEWER_END, rewritten)
    report = baseline_shadow.shadow(composite, scheduled_for=STAMP)
    assert report["history_version"]["candidate_version_id"] == version
    frame = next(item for item in report["bars"]["frames"] if item["timeframe"] == "M1")
    assert frame["history"]["status"] == "compared"
    assert frame["history"]["same"] == 0 and frame["history"]["changed"] == 2
    assert frame["history"]["max_price_delta"] == pytest.approx(0.1)
    assert frame["history"]["added"] == 0 and frame["history"]["missing"] == 0
    assert report["bindings"]["active_revision_id"]["unchanged"] is True
def test_gap_list_reports_missing_minutes_and_uncovered_intervals(database, monkeypatch):
    composite, active, candidate, plan, _ = candidate_fixture(database, monkeypatch)
    gap = plan["seam"] + 5 * 60000
    with database.begin() as db:
        # The source watermark advanced past minutes this revision never got.
        db.get(CompositePreparation, candidate).confirmed_end = gap + 4 * 60000
    monkeypatch.setattr("alerts.composite_series._closed", lambda *args: True)
    report = baseline_shadow.shadow(composite, scheduled_for=STAMP)
    gaps = report["gaps"]
    assert gaps["missing_minutes"] == [{"start": gap, "end": gap + 4 * 60000, "minutes": 4}]
    assert gaps["scanned"]["expected_minutes"] == 9
    assert gaps["scanned"]["observed_minutes"] == 5
    assert [item["segment"] for item in gaps["uncovered"]] == ["target"]
    assert gaps["uncovered"][0]["start"] == gap + 4 * 60000
