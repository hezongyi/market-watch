"""Graph display inputs must never change strict persisted indicator semantics."""

import copy

import pytest
from alerts.chart_api import DataQuery, data_sync
from alerts.chart_indicators import calculate
from alerts.indicator_state import IndicatorState
from alerts.observed_indicators import ObservedState, output_row, status
from alerts.storage import FixedIndicatorRun
from test_fixed_indicators import drain, history
from test_indicator_state import SPECS, prices

OBSERVED = "observed_display_v1"
SPEC = {"name": "EMA", "params": {"period": 5}}


def test_display_and_strict_runs_have_separate_identities(database, monkeypatch):
    version = history(database, monkeypatch, count=80)
    strict_query = DataQuery(
        instrument=version, series_kind="history", timeframe="M1", limit=20, indicators=[SPEC]
    )
    observed_query = DataQuery(**{**strict_query.model_dump(), "indicator_input_policy": OBSERVED})
    strict = data_sync(strict_query)
    observed = data_sync(observed_query)
    strict_id = strict["indicator_progress"][0]["run_id"]
    observed_id = observed["indicator_progress"][0]["run_id"]
    assert strict_id != observed_id
    drain(strict_id)
    drain(observed_id)
    strict = data_sync(strict_query)["indicators"][0]
    observed = data_sync(observed_query)["indicators"][0]
    assert strict["series"] == observed["series"]
    with database.begin() as db:
        a, b = db.get(FixedIndicatorRun, strict_id), db.get(FixedIndicatorRun, observed_id)
        assert a.algorithm != b.algorithm
        assert a.group_key != b.group_key
        assert a.parent_id is None and b.parent_id is None
        old_state = copy.deepcopy(a.state)
    data_sync(observed_query)
    with database.begin() as db:
        assert db.get(FixedIndicatorRun, strict_id).state == old_state


def test_observed_policy_rejects_fixed_confirmed_revision():
    with pytest.raises(ValueError, match="input_revision"):
        DataQuery(
            instrument="example",
            series_kind="composite",
            timeframe="M1",
            input_revision=1,
            indicator_input_policy=OBSERVED,
        )


SWING = {"name": "SWING_SR_V1", "params": {"high_strength": 5, "low_strength": 5}}
SUPER = {"name": "SUPERTREND_PINE_V1", "params": {"period": 7, "multiplier": 2}}


def observed_prices(count=400):
    return [{**row, "open": row["close"]} for row in prices(count)]


@pytest.mark.parametrize("spec", [*SPECS, SWING, SUPER])
def test_observed_sequence_matches_shared_formula_and_checkpoint(spec):
    rows = observed_prices()
    original = copy.deepcopy(rows)
    engine = ObservedState(spec)
    outputs = []
    for index, row in enumerate(rows):
        if index % 31 == 0:
            engine = ObservedState(spec, engine.checkpoint())
        # Actual observed sequence has uncertain coverage and clock gaps.
        values = engine.step({**row, "complete": index % 3 != 0, "gap_before": index == 130})
        outputs.append(values)
    expected = calculate(rows, spec)
    for series in expected["series"]:
        assert [row[series["key"]] for row in outputs] == pytest.approx(
            [point["value"] for point in series["values"]], abs=1e-8
        )
    assert rows == original
    assert engine.last_quality["coverage"] == "unverified"
    with pytest.raises(ValueError):
        IndicatorState(spec, engine.checkpoint())
    with pytest.raises(ValueError):
        ObservedState(spec, IndicatorState(spec).checkpoint())


@pytest.mark.parametrize("spec", [SPEC, SWING, SUPER])
def test_forming_updates_are_retractable_and_confirmation_advances_once(spec):
    rows = observed_prices(100)
    engine = ObservedState(spec)
    for row in rows[:-1]:
        engine.step(row)
    original = engine.checkpoint()
    forming = {**rows[-1], "complete": False, "time_closed": False}
    first = engine.step(forming, provisional=True)
    trial_quality = copy.deepcopy(engine.last_quality)
    assert trial_quality["provisional"]
    assert engine.checkpoint() == original
    engine.step({**forming, "close": forming["high"]}, provisional=True)
    assert engine.checkpoint() == original
    assert engine.step(forming, provisional=True) == first
    engine.step(rows[-1])
    assert engine.meta["n"] == 100
    assert not engine.last_quality["provisional"]


def test_partial_bounds_invalid_prices_and_unknown_gaps_are_distinct():
    rows = observed_prices(20)
    engine = ObservedState(SPEC, source_start=1, source_end=19 * 60000)
    assert all(value is None for value in engine.step(rows[0]).values())
    assert engine.last_quality["reason_code"] == "PARTIAL_PERIOD"
    for row in rows[1:9]:
        engine.step(row)
    assert engine.step({**rows[9], "gap_before": True})["value"] is not None
    assert engine.last_quality["coverage"] == "unverified"
    assert engine.last_quality["reason_code"] == "UNKNOWN_INPUT_GAP"
    assert all(value is None for value in engine.step({**rows[10], "high": float("nan")}).values())
    assert engine.last_quality["reason_code"] == "INVALID_PRICE"
    assert engine.meta["n"] == 0
    engine.step(rows[19])
    assert engine.last_quality["reason_code"] == "PARTIAL_PERIOD"


@pytest.mark.parametrize(
    "name,recursive",
    [
        ("SMA", False),
        ("LWMA", False),
        ("BBANDS", False),
        ("EMA", True),
        ("RSI", True),
        ("ATR", True),
    ],
)
def test_quality_tracks_dependencies_not_latest_bar(name, recursive):
    engine = ObservedState({"name": name, "params": {"period": 5}})
    for index, row in enumerate(observed_prices(30)):
        engine.step({**row, "complete": index != 6})
        if index == 7:
            assert engine.last_quality["coverage"] == "unverified"
    assert (engine.last_quality["coverage"] == "unverified") is recursive


def test_no_pivot_after_warmup_is_ready_not_an_infinite_pending():
    engine = ObservedState(SWING)
    output = []
    for row in observed_prices(12):
        row = {**row, "open": 1, "high": 1, "low": 1, "close": 1, "complete": False}
        output.append(output_row(engine, row, engine.step(row)))
    assert status(output[:5], complete=True)["value_status"] == "insufficient_input"
    assert status(output, complete=True)["value_status"] == "ready"
    assert all(value is None for row in output for value in row["values"].values())


def test_incomplete_higher_period_api_returns_observed_values_preserving_strict(
    database, monkeypatch
):
    from alerts.history_artifacts import artifact_tick, read_artifact
    from alerts.history_versions import create_version, import_page
    from test_composite_definitions import prepare
    from test_history_versions import Adapter
    from test_market_contracts import batch, identity, minute

    prepare(database, monkeypatch)
    count = 20 * 60
    with database.begin() as db:
        version = create_version(db, identity().key, 0, count * 60000)
    rows = tuple(
        minute(
            row["start"],
            open=str(row["close"]),
            high=str(row["high"]),
            low=str(row["low"]),
            close=str(row["close"]),
        )
        for i, row in enumerate(prices(count))
        if i % 60 != 30
    )
    import_page(
        Adapter([batch(window_end=count * 60000, checkpoint=count * 60000, rows=rows)]),
        version_id=version,
    )
    from alerts.history_artifacts import request_artifacts
    from alerts.storage import HistoryVersion

    with database.begin() as db:
        request_artifacts(db, db.get(HistoryVersion, version), ["H1"])
    while artifact_tick(version):
        pass
    query = DataQuery(
        instrument=version,
        series_kind="history",
        timeframe="H1",
        limit=20,
        indicators=[SWING, SPEC],
        indicator_input_policy=OBSERVED,
    )
    for policy in (OBSERVED, "strict_confirmed_v1"):
        pending = data_sync(query.model_copy(update={"indicator_input_policy": policy}))
        for progress in pending["indicator_progress"]:
            drain(progress["run_id"])
    observed = data_sync(query)
    strict = data_sync(query.model_copy(update={"indicator_input_policy": "strict_confirmed_v1"}))
    assert observed["bars"] == strict["bars"]
    assert all(not row["complete"] for row in observed["bars"])
    assert all(
        point["value"] is None
        for item in strict["indicators"]
        for s in item["series"]
        for point in s["values"]
    )
    ema = observed["indicators"][1]
    assert any(point["value"] is not None for point in ema["series"][0]["values"])
    assert ema["calculation"]["value_status"] == "ready"
    assert ema["calculation"]["input_quality"]["coverage"] == "unverified"
    with database.begin() as db:
        assert all(not row["complete"] for row in read_artifact(db, version, "H1", limit=30))
    older = data_sync(query.model_copy(update={"before": observed["bars"][-7]["start"]}))
    assert older["indicators"][0]["presentation"] == observed["indicators"][0]["presentation"]


@pytest.mark.parametrize("spec", [SPEC, SWING, SUPER])
def test_composite_snapshot_suffix_and_pagination_are_fenced(database, monkeypatch, spec):
    from alerts.composite_chart import chart_page
    from alerts.storage import CompositeRevision, ObservedMinute, RealtimeMapping
    from test_composite_aggregates import drain as aggregates
    from test_composite_chart import populated

    composite, revision, seam = populated(database, monkeypatch)
    aggregates(revision, "M1")
    stamp = seam + 13 * 60000 + 1000
    monkeypatch.setattr("alerts.series_access.now_ms", lambda: stamp)
    with database.begin() as db:
        target = db.get(
            RealtimeMapping, db.get(CompositeRevision, revision).mapping_id
        ).target_dataset_id
        for i in range(10, 14):
            start = seam + i * 60000
            db.add(
                ObservedMinute(
                    dataset_id=target,
                    start=start,
                    epoch=1,
                    observed_at=start + 500,
                    sequence=i,
                    content={
                        "start": start,
                        "end": start + 60000,
                        "open": "1.11",
                        "high": "1.15",
                        "low": "1.1",
                        "close": "1.12",
                        "complete": False,
                        "volume": None,
                    },
                )
            )
        price = chart_page(db, composite, "M1", count=30, now=stamp, provisional=True)
    body = DataQuery(
        instrument=composite,
        series_kind="composite",
        timeframe="M1",
        limit=30,
        provisional=True,
        indicators=[spec],
        indicator_input_policy=OBSERVED,
        display_snapshot_id=price["display_snapshot_id"],
    )
    first = data_sync(body)
    ident = first["indicator_progress"][0]["run_id"]
    drain(ident)
    with database.begin() as db:
        original = copy.deepcopy(db.get(FixedIndicatorRun, ident).state)
    reads = []

    def measured_read(*args, **kwargs):
        reads.append(kwargs)
        return chart_page(*args, **kwargs)

    monkeypatch.setattr("alerts.composite_chart.chart_page", measured_read)
    actual = data_sync(body)["indicators"][0]
    assert len(reads) == 1, "An accepted current page must not re-read its M1 suffix"
    assert actual["calculation"]["visible_complete"]
    assert actual["dependencies"][-1]["provisional"]
    assert not actual["dependencies"][-2]["provisional"]
    expected = calculate(
        [{**bar, "complete": True, "gap_before": False} for bar in price["bars"]], spec
    )
    for series, wanted in zip(actual["series"], expected["series"]):
        assert [p["value"] for p in series["values"]] == pytest.approx(
            [p["value"] for p in wanted["values"]], abs=1e-8
        )
    with database.begin() as db:
        row = db.get(ObservedMinute, (target, seam + 12 * 60000, 1))
        row.content = {**row.content, "close": "1.14"}
    frozen = data_sync(body)["indicators"][0]
    assert frozen["series"] == actual["series"]
    assert frozen.get("presentation") == actual.get("presentation")
    older = data_sync(body.model_copy(update={"before": seam + 7 * 60000}))["indicators"][0]
    assert older.get("presentation") == actual.get("presentation")
    if spec == SPEC:
        batch_body = body.model_copy(update={"indicators": [SPEC, SWING, SUPER]})
        batch = data_sync(batch_body)
        for progress in batch["indicator_progress"]:
            drain(progress["run_id"])
        reads.clear()
        batch = data_sync(batch_body.model_copy(update={"before": seam + 7 * 60000}))
        assert all(item["calculation"]["visible_complete"] for item in batch["indicators"])
        assert len(reads) == 3, "Paged studies must share the frozen tail and suffix reads"
    with database.begin() as db:
        assert db.get(FixedIndicatorRun, ident).state == original
        from alerts.storage import DisplayIndicatorTask
        from sqlalchemy import select

        assert list(db.scalars(select(DisplayIndicatorTask))) == []


def test_observed_encoded_identity_accepts_legacy_managed_entry():
    body = DataQuery(
        instrument="MWH:63bc01d4-3943-45cc-93a5-b04c3caaab16",
        timeframe="M1",
        indicator_input_policy=OBSERVED,
    )
    assert body.indicator_input_policy == OBSERVED


def test_retained_snapshot_keeps_its_original_forming_clock(database, monkeypatch):
    from alerts.composite_chart import chart_page
    from test_composite_aggregates import drain as aggregates
    from test_composite_chart import populated

    composite, revision, seam = populated(database, monkeypatch)
    aggregates(revision, "M5")
    old_stamp = seam + 9 * 60000 + 1000
    new_stamp = old_stamp + 60000
    with database.begin() as db:
        price = chart_page(db, composite, "M5", count=30, now=old_stamp, provisional=True)
    monkeypatch.setattr("alerts.series_access.now_ms", lambda: new_stamp)
    spec = {"name": "EMA", "params": {"period": 2}}
    body = DataQuery(
        instrument=composite,
        series_kind="composite",
        timeframe="M5",
        limit=30,
        provisional=True,
        indicators=[spec],
        indicator_input_policy="observed_display_v1",
        display_snapshot_id=price["display_snapshot_id"],
    )
    pending = data_sync(body)
    ident = pending["indicator_progress"][0]["run_id"]
    drain(ident)
    actual = data_sync(body)
    if not actual["bars"][-1]["time_closed"]:
        assert actual["indicators"][0]["dependencies"][-1]["provisional"]


def test_foreground_never_substitutes_durable_prices_for_snapshot(database, monkeypatch):
    from alerts.composite_chart import chart_page
    from alerts.composite_inputs import apply_minutes
    from alerts.confirmed_minutes import record
    from alerts.market_contracts import DatasetIdentity
    from alerts.storage import CompositeRevision, MarketDataset, ObservedMinute, RealtimeMapping
    from test_composite_aggregates import drain as aggregates
    from test_composite_preparation import ready
    from test_market_contracts import batch, minute

    revision_id = ready(database, monkeypatch)
    with database.begin() as db:
        revision = db.get(CompositeRevision, revision_id)
        target = db.get(
            MarketDataset, db.get(RealtimeMapping, revision.mapping_id).target_dataset_id
        )
        ident = DatasetIdentity.model_validate(target.identity)
        seam = revision.seam
        source = batch(
            identity=ident,
            window_start=seam,
            window_end=seam + 600000,
            checkpoint=seam + 600000,
            observed_at=seam + 600000,
            volume_kind="price_count",
            volume_unit="quotes",
            rows=tuple(
                minute(at, volume="3")
                for at in range(seam, seam + 600000, 60000)
                if at != seam + 240000
            ),
        )
        apply_minutes(db, record(db, source))
        composite = revision.composite_id
        parent = revision.history_version_id
        db.add(
            ObservedMinute(
                dataset_id=target.id,
                start=seam + 240000,
                epoch=1,
                observed_at=seam + 240500,
                sequence=1,
                content={
                    "start": seam + 240000,
                    "end": seam + 300000,
                    "open": "10",
                    "high": "15",
                    "low": "9",
                    "close": "12",
                    "complete": False,
                    "volume": None,
                },
            )
        )
    from alerts.history_artifacts import artifact_tick
    while artifact_tick(parent):
        pass
    aggregates(revision_id, "M5")
    stamp = seam + 600000 + 1000
    monkeypatch.setattr("alerts.series_access.now_ms", lambda: stamp)
    with database.begin() as db:
        price = chart_page(
            db, composite, "M5", before=seam + 600000, count=30, now=stamp, provisional=True
        )
    spec = {"name": "EMA", "params": {"period": 2}}
    body = DataQuery(
        instrument=composite,
        series_kind="composite",
        timeframe="M5",
        before=seam + 600000,
        limit=30,
        provisional=True,
        indicators=[spec],
        indicator_input_policy="observed_display_v1",
        display_snapshot_id=price["display_snapshot_id"],
        client="probe",
        indicator_consumers=[{"id": "probe", "generation": 1, "spec": spec}],
    )
    first = data_sync(body)
    ident = first["indicator_progress"][0]["run_id"]
    drain(ident)
    later = data_sync(body)
    assert not first["indicators"][0]["calculation"]["visible_complete"]
    assert later["indicators"][0]["calculation"]["visible_complete"]
    expected = calculate([{**bar, "complete": True} for bar in later["bars"]], spec)
    assert [p["value"] for p in later["indicators"][0]["series"][0]["values"]] == pytest.approx(
        [p["value"] for p in expected["series"][0]["values"]]
    )
