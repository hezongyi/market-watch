"""The foreground path uses the worker oracle, including every published plot."""

from types import SimpleNamespace

import pytest
from alerts import fixed_indicator_display as display
from alerts import fixed_indicators as jobs
from alerts.chart_api import DataQuery, data_sync
from alerts.chart_indicators import CATALOG
from alerts.storage import FixedIndicatorRun
from sqlalchemy import event
from test_fixed_indicators import drain, history
from test_indicator_state import SPECS, prices


def test_confirmed_composite_foreground_skips_redundant_display_suffix(database, monkeypatch):
    from test_composite_aggregates import drain as aggregates
    from test_composite_chart import populated

    composite, revision, seam = populated(database, monkeypatch)
    aggregates(revision, "M1")
    spec = {"name": "EMA", "params": {"period": 2}}
    body = DataQuery(instrument=composite, series_kind="composite", timeframe="M1", before=seam,
        limit=2, provisional=True, indicators=[spec], client="confirmed-display-test",
        indicator_consumers=[{"id": "study", "generation": 1, "spec": spec}])

    def redundant(*args, **kwargs):
        raise AssertionError("Confirmed foreground inputs must not scan or enqueue a display suffix")

    monkeypatch.setattr("alerts.display_indicators.suffix", redundant)
    result = data_sync(body)
    actual = result["indicators"][0]
    assert actual["calculation"]["visible_complete"]
    assert not actual["calculation"]["display_task_ids"]
    assert actual["calculation"]["execution"]["result_cache"] == "miss"
    drain(actual["calculation"]["run_id"])
    canonical = data_sync(body.model_copy(update={"client": None, "indicator_consumers": [],
        "provisional": False}))["indicators"][0]
    assert actual["series"] == canonical["series"]
    assert actual["dependencies"] == canonical["dependencies"]


def test_chart_route_serializes_native_json_catalog_payload_without_recursive_reencoding(database, monkeypatch):
    from alerts import api
    from fastapi import routing
    from fastapi.testclient import TestClient

    version = history(database, monkeypatch, count=300)
    specs = [{"name": name} for name in CATALOG]
    pending = data_sync(DataQuery(instrument=version, series_kind="history", timeframe="M1",
        limit=25, indicators=specs))
    for progress in pending["indicator_progress"]:
        drain(progress["run_id"])
    original = routing.jsonable_encoder

    def encode(value, *args, **kwargs):
        assert not (isinstance(value, dict) and "bars" in value and "indicators" in value), (
            "Chart payloads already use JSON types; avoid a second recursive walk")
        return original(value, *args, **kwargs)

    monkeypatch.setattr(routing, "jsonable_encoder", encode)
    api.app.dependency_overrides[api.authenticated] = lambda: "test"
    try:
        with TestClient(api.app) as client:
            result = client.post("/api/charts/data", json={"instrument": version,
                "series_kind": "history", "timeframe": "M1", "limit": 25,
                "indicators": specs})
            assert result.status_code == 200, result.text
            assert result.headers["content-type"] == "application/json"
            page = result.json()
            assert len(page["bars"]) == 25
            assert {item["name"] for item in page["indicators"]} == set(CATALOG)
            assert all(len(series["values"]) == 25 for item in page["indicators"] for series in item["series"])
    finally:
        api.app.dependency_overrides.clear()


def query(version, spec, generation=1):
    return DataQuery(instrument=version, series_kind="history", timeframe="M1", limit=25,
        indicators=[spec], client="display-test", indicator_consumers=[
            {"id": "study", "generation": generation, "spec": spec}])


@pytest.mark.parametrize("name", CATALOG)
def test_all_catalog_foreground_values_dependencies_and_presentation_match_worker(database, monkeypatch, name):
    version = history(database, monkeypatch, count=300)
    spec = {"name": name, "params": CATALOG[name]["params"]}
    body = query(version, spec)
    result = data_sync(body)
    actual = result["indicators"][0]
    assert actual["calculation"]["visible_complete"]
    assert actual["calculation"]["execution"]["calculation_steps"] == 300
    # Display readiness neither publishes nor advances durable worker state.
    run_id = actual["calculation"]["run_id"]
    with database.begin() as db:
        assert db.get(FixedIndicatorRun, run_id).cursor == result["origin"]
    drain(run_id)
    canonical = data_sync(body.model_copy(update={"client": None, "indicator_consumers": []}))["indicators"][0]
    for series, expected in zip(actual["series"], canonical["series"]):
        assert {key: value for key, value in series.items() if key != "values"} == {
            key: value for key, value in expected.items() if key != "values"}
        for point, reference in zip(series["values"], expected["values"]):
            assert {key: value for key, value in point.items() if key != "value"} == {
                key: value for key, value in reference.items() if key != "value"}
            assert point["value"] == pytest.approx(reference["value"], abs=1e-8, rel=1e-10)
    assert actual["dependencies"] == canonical["dependencies"]
    if "presentation" in actual:
        assert actual["presentation"] == canonical["presentation"]


def test_shared_inputs_distinct_specs_result_hits_and_bounded_fallback(database, monkeypatch):
    version = history(database, monkeypatch, count=300)
    first = data_sync(query(version, {"name": "EMA", "params": {"period": 19}}))
    repeated = data_sync(query(version, {"name": "EMA", "params": {"period": 19}}))
    stats = repeated["indicators"][0]["calculation"]["execution"]
    assert stats["input_cache"] == stats["result_cache"] == "hit" and stats["calculation_steps"] == 0
    second = data_sync(query(version, {"name": "EMA", "params": {"period": 23}}, generation=2))
    stats = second["indicators"][0]["calculation"]["execution"]
    assert stats["input_cache"] == "hit" and stats["calculation_steps"] == 300
    assert first["indicators"][0]["series"] != second["indicators"][0]["series"]


def test_long_prefix_keeps_real_pending_progress_without_approximation(database, monkeypatch):
    version = history(database, monkeypatch, count=301)
    monkeypatch.setattr(display, "MAX_FOREGROUND_ROWS", 100)
    fallback = data_sync(query(version, {"name": "EMA", "params": {"period": 500}}))
    assert not fallback["indicators"][0]["calculation"]["visible_complete"]
    assert fallback["indicators"][0]["series"][0]["values"] == []
    progress = fallback['indicators'][0]['calculation']
    assert progress['execution'] == {'path': 'durable-fixed', 'input_rows': 301,
                                    'result_cache': 'miss', 'calculation_steps': 0}
    drain(progress['run_id'])
    completed = data_sync(query(version, {"name": "EMA", "params": {"period": 500}}))
    execution = completed['indicators'][0]['calculation']['execution']
    assert execution['input_rows'] == 301 and execution['result_cache'] == 'hit'


def test_math_runs_after_database_transaction_closes(database, monkeypatch):
    version = history(database, monkeypatch, count=300)
    original = jobs.calculate_inputs
    checked = []
    active = []
    engine = database.kw["bind"]
    event.listen(engine, "begin", lambda connection: active.append(connection))
    event.listen(engine, "commit", lambda connection: active.remove(connection))
    event.listen(engine, "rollback", lambda connection: active.remove(connection))

    def calculate(*args, **kwargs):
        assert not active, "Numerical work retained a request transaction"
        with database.begin() as db:
            checked.append(db.get(FixedIndicatorRun, args[0].id) is not None)
        return original(*args, **kwargs)

    monkeypatch.setattr(jobs, "calculate_inputs", calculate)
    data_sync(query(version, {"name": "EMA", "params": {"period": 500}}))
    assert checked == [True]


@pytest.mark.parametrize("spec", SPECS)
@pytest.mark.parametrize("shape", ["ordinary", "gap", "seam"])
def test_batch_oracle_preserves_worker_null_and_dependency_semantics(spec, shape):
    rows = prices(1400)
    if shape == "gap":
        rows[1300]["complete"] = False
        del rows[830:840]
    run = SimpleNamespace(spec=spec, state=None, timeframe="M1")
    profiles = [(0, rows[-1]["end"], {})]
    seam = 700 * 60000 if shape == "seam" else None
    worker = jobs.calculate_inputs(run, rows, "utc0", profiles, seam=seam)
    batch = jobs.calculate_inputs(run, rows, "utc0", profiles, seam=seam, batch=True)
    assert batch["state"] is None, "Batch display cannot masquerade as a resumable seed"
    for actual, expected in zip(batch["rows"], worker["rows"]):
        assert {key: value for key, value in actual.items() if key != "values"} == {
            key: value for key, value in expected.items() if key != "values"}
        assert actual["values"] == pytest.approx(expected["values"], abs=1e-8, rel=1e-10)
