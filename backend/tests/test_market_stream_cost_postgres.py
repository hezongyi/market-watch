"""Synthetic composite cost probes on the task's real PostgreSQL.

These measure actual Calculator/SQL work, not supplier or browser latency.
Each scenario owns and removes a random schema in the isolated Docker database.
"""

import importlib
import json
import os
import time
from collections import Counter
from pathlib import Path

import pytest
from alerts import live_pricing as live
from alerts import market_stream as stream
from alerts.chart_api import DataQuery
from alerts.composite_inputs import apply_minutes
from alerts.confirmed_minutes import record
from alerts.market_contracts import DatasetIdentity, QuoteEvent
from alerts.market_stream_api import Subscription, resolve
from alerts.market_stream_worker import Calculator
from alerts.storage import CompositeRevision, MarketDataset, RealtimeMapping
from sqlalchemy import event
from test_composite_chart import populated
from test_fixed_series_revisions import correction
from test_market_contracts import batch, minute
from test_market_stream import session
from test_provider_postgres import provider_pg as _provider_pg

provider_pg = _provider_pg
pytestmark = pytest.mark.skipif(not os.getenv("TEST_POSTGRES_URL"),
                               reason="Requires task-local PostgreSQL")


@pytest.mark.parametrize("frame", ["W1", "MN"])
@pytest.mark.parametrize("consumers", [1, 8])
def test_shared_composite_quote_cost(provider_pg, monkeypatch, frame, consumers):
    factory, engine = provider_pg
    composite, revision_id, seam = populated(factory, monkeypatch)
    count = 5000
    clock = seam + count * 60000 + 10000
    for name in ("market_stream", "market_stream_worker", "series_access", "composite_series",
                 "composite_chart", "composite_quotes", "market_data"):
        module = importlib.import_module("alerts." + name)
        if hasattr(module, "now_ms"):
            monkeypatch.setattr(module, "now_ms", lambda: clock)
    with factory.begin() as db:
        revision = db.get(CompositeRevision, revision_id)
        target = db.get(MarketDataset, db.get(RealtimeMapping, revision.mapping_id).target_dataset_id)
        identity = DatasetIdentity.model_validate(target.identity)
        rows = tuple(minute(seam + offset * 60000, volume="3") for offset in range(count))
        apply_minutes(db, record(db, batch(identity=identity, window_start=seam,
            window_end=seam + count * 60000, checkpoint=seam + count * 60000,
            observed_at=clock, rows=rows, volume_kind="price_count", volume_unit="quotes")))
    owner = live.claim(live.settings.oanda_account_id, now=clock)
    assert owner
    epoch = live.begin_connection(owner, {identity.provider_symbol:identity}, now=clock)
    auth = session(factory)
    query = DataQuery(instrument=composite, series_kind="composite", timeframe=frame, provisional=True)
    shared, serialized = resolve(Subscription(client="cost-0", listener="chart", generation=1,
        kind="bars", query=query))
    registrations = [stream.register(auth, "cost-"+str(index), "chart", 1, shared, serialized, {})
                     for index in range(consumers)]
    assert len({row["task_id"] for row in registrations}) == 1
    calculator = Calculator()
    cursors = [{} for _ in range(consumers)]
    sql = Counter()
    samples = []

    # PostgreSQL server-side cursors report rowcount=-1. Count rows yielded
    # by the real minute readers too, rather than claiming zero scans.
    def count_reader(original):
        def counted(*args, **kwargs):
            for row in original(*args, **kwargs):
                sql["minute_rows_yielded"] += 1
                yield row
        return counted

    from alerts import composite_inputs, composite_series

    monkeypatch.setattr(composite_inputs, "rows", count_reader(composite_inputs.rows))
    monkeypatch.setattr(composite_series, "tail_rows", count_reader(composite_series.tail_rows))
    monkeypatch.setattr(composite_series, "snapshot_rows", count_reader(composite_series.snapshot_rows))

    def observe(connection, cursor, statement, parameters, context, executemany):
        verb = statement.lstrip().split(None, 1)[0].upper()
        sql[verb] += 1
        if verb == "SELECT":
            sql["selected_rows"] += max(0, cursor.rowcount)
            if "market_composite_minute_inputs" in statement or "market_source_minute_revisions" in statement:
                sql["minute_selected_rows"] += max(0, cursor.rowcount)

    def quote(sequence):
        price = f"{1.12 + sequence / 100000:.5f}"
        live.publish_event(owner, epoch, QuoteEvent(identity=identity, bid=price, ask="1.13",
            source_time=clock-5000+sequence, received_at=clock-4000+sequence,
            tradeable=True, connection_epoch=epoch, sequence=sequence),
            {identity.provider_symbol:identity}, now=clock)

    def compute():
        work = stream.claim()
        assert work
        started = time.perf_counter()
        payload, _ = calculator.build(work)
        elapsed = (time.perf_counter()-started)*1000
        assert payload and payload["bars"]
        stream.commit(work, payload, delay_ms=0)
        for index in range(consumers):
            delivered = stream.events(auth, "cost-"+str(index), cursors[index])
            assert delivered and delivered[-1]["type"] == "bars"
        return payload, elapsed

    quote(1)
    event.listen(engine, "after_cursor_execute", observe)
    try:
        initial, cold_ms = compute()
        initial_sql = dict(sql)
        assert calculator.buckets.builds == 1
        for sequence in range(2, 8):
            quote(sequence)
            sql.clear()
            payload, elapsed = compute()
            samples.append({"calculation_ms":round(elapsed,3), **dict(sql)})
            assert calculator.buckets.builds == 1, "Quote changes cannot reconstruct the current bucket"
            assert sql["minute_rows_yielded"] < count, "Warm quote changes must not reread all 5000 M1 inputs"
        with factory.begin() as db:
            correction(db, revision_id, seam + (count - 1) * 60000, clock, "1.115")
        sql.clear()
        payload, delta_ms = compute()
        delta_sql = dict(sql)
        assert calculator.buckets.builds == 1
        assert calculator.buckets.delta_reads == 1
        assert sql["minute_rows_yielded"] < count, "One confirmed correction must use indexed deltas"
        work = stream.claim()
        sql.clear()
        idle, _ = calculator.build(work)
        stream.commit(work, idle, delay_ms=0)
        assert idle is None and calculator.computations == 8
        idle_sql = dict(sql)
    finally:
        event.remove(engine, "after_cursor_execute", observe)
    with factory.begin() as db:
        from alerts.series_access import chart_data

        authoritative = chart_data(db, query.model_copy(update={"limit":2000}))
        for produced, expected in zip(payload["bars"], authoritative["bars"], strict=True):
            differences = {key:[produced.get(key),expected.get(key)] for key in produced.keys() | expected.keys()
                           if produced.get(key) != expected.get(key)}
            assert not differences, json.dumps(differences)
    report = {"frame":frame,"consumers":consumers,"confirmed_m1":count,
        "shared_tasks":1,"computations":calculator.computations,"bucket_builds":calculator.buckets.builds,
        "cold_calculation_ms":round(cold_ms,3),"cold_sql":initial_sql,
        "warm_samples":samples,"idle_sql":idle_sql,"synthetic":True,
        "confirmed_delta_ms":round(delta_ms,3),"confirmed_delta_sql":delta_sql,
        "scope":"real PostgreSQL Calculator/SQL cost with a frozen source clock; not browser or supplier SLA"}
    print(json.dumps(report))
    if output := os.getenv("MARKET_STREAM_COST_REPORT"):
        directory = Path(output)
        directory.mkdir(parents=True,exist_ok=True)
        (directory / f"{frame}-{consumers}.json").write_text(json.dumps(report,indent=2)+"\n")
