"""Synthetic PostgreSQL baseline through the real worker call chain, no provider I/O.

Only the dedicated Compose database is accepted. Clock and events are fixed;
monotonic time measures latency. Timing samples include contention, not production SLA.
"""
import argparse
import hashlib
import json
import os
import platform
import resource
import time
from collections import Counter
from dataclasses import replace
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

from sqlalchemy import event, func, select, text
from sqlalchemy.engine import make_url

url = make_url(os.environ.get("ALERTS_DATABASE_URL", ""))
if (url.get_backend_name(), url.host, url.database, url.username) != ("postgresql", "postgres", "issue13", "issue13"):
    raise SystemExit("Use the isolated mw-issue13-p0 Compose probe, not an external database")

from alerts import managed_dataset as m, storage as s
from alerts.bar_batch import write_bars
from alerts.chart_aggregation import aggregate_once
from alerts.chart_aggregation_worker import wait_seconds
from alerts.market import ingest, stored_coverage

MINUTE = 60000
START = s.ms(datetime(2026, 8, 1, tzinfo=UTC))
COUNT = 64000
NOW = START + COUNT * MINUTE + 5000
IDENTITIES = ["EURUSD", "XAUUSD", "BTCUSDT"] + [f"SYNTH{i:02}" for i in range(7)]
ROOT = Path("/results")
clock = NOW
m.now_ms = lambda: clock
s.now_ms = lambda: clock


def fixture_tables():
    from sqlalchemy import inspect
    available = set(inspect(s.engine).get_table_names())
    names = ['chart_published_bars', 'chart_publications', 'chart_history_plans']
    return names + [name for name in ('chart_publication_state', 'market_coverage_checkpoints',
        'market_coverage_projection', 'market_coverage_quarantine') if name in available]


def write_json(name, data):
    (ROOT / name).write_text(json.dumps(data, indent=2, default=str) + "\n")


def setup():
    # Apply the real migration chain to a fresh dedicated DB before seeding.
    from alembic.config import Config
    from alembic import command
    command.upgrade(Config("alembic.ini"), "head")
    s.bootstrap()
    with s.engine.begin() as conn:
        conn.execute(text("CREATE EXTENSION IF NOT EXISTS pg_stat_statements"))
    with s.transaction() as db:
        if db.scalar(select(func.count()).select_from(s.Bar)):
            raise SystemExit("Fixture already exists; never seed twice into persistent data")
        for i, ident in enumerate(IDENTITIES):
            inst = db.get(s.Instrument, ident)
            if inst is None:
                inst = s.Instrument(id=ident, label="Synthetic " + ident, source="binance", symbol=ident,
                                    basis="last", calendar="utc0", precision=2)
                db.add(inst)
                db.flush()
            m.join(db, inst, START, NOW)
            # Initial plan only maintains last 2000 minutes; the remaining history
            # is available in staging for the later explicit backfill expansion.
            plan = db.get(s.ChartHistoryPlan, ident)
            plan.target_start = START + (COUNT - 2000) * MINUTE
            db.add(s.MarketCoverage(instrument_id=ident, source=inst.source, basis=inst.basis,
                                   start=START, end=NOW-5000, queried_at=NOW))
            db.flush()
            price = i + 100
            # Source pages with constant OHLC make expected results independent
            # of the production aggregate implementation; NY17 H4/D1 boundaries
            # are built with the domain calendar below, not fixed UTC divisions.
            for frame, step in (("M1", 1), ("M5", 5), ("M15", 15), ("H1", 60)):
                db.execute(text("""
                    INSERT INTO candles (instrument_id,timeframe,start,"end",open,high,low,close,
                      complete,revision,received_at,observed_at,volume,volume_complete,volume_received_at,volume_revision)
                    SELECT :ident,:frame,:start+n::bigint*:width,:start+(n::bigint+1)*:width,:price,:price+1,:price-1,:price,
                      true,1,:now,:now,:amount,true,:now,1 FROM generate_series(0,:count-1) n
                """), dict(ident=ident, frame=frame, start=START, width=step*MINUTE,
                            count=COUNT//step, price=price, amount=Decimal(step), now=NOW))
            from alerts.domain import Calendar, bucket_bounds
            for frame in ("H4", "D1"):
                rows = []
                at = START
                while at < NOW-5000:
                    a, b = map(s.ms, bucket_bounds(s.instant(at), frame, Calendar(inst.calendar)))
                    if a >= START and b <= NOW-5000:
                        rows.append(dict(instrument_id=ident, timeframe=frame, start=a, end=b, open=price,
                            high=price+1, low=price-1, close=price, complete=True, revision=1,
                            received_at=NOW, observed_at=NOW, volume=Decimal((b-a)//MINUTE),
                            volume_complete=True, volume_received_at=NOW, volume_revision=1))
                    at = b
                db.execute(s.Bar.__table__.insert(), rows)
        # Issue-scale audit table, including 60k irrelevant OANDA query records.
        db.execute(text("""
            INSERT INTO audit_events(kind,at,details)
            SELECT CASE WHEN n<=60000 THEN 'provider_query_coverage' ELSE 'fixture_unrelated' END,:now,
             json_build_object('instrument','OTHER','source','oanda','basis','bid','received_at',:now,
                               'range_start',:start,'range_end',:stop,'ranges',json_build_array(json_build_object('start',:start,'end',:stop)))
            FROM generate_series(1,388893) n
        """), dict(now=NOW, start=START, stop=NOW-5000))
        for ident in IDENTITIES[:2]:
            db.add(s.Audit(kind="provider_query_coverage", at=NOW, details=dict(instrument=ident,
                source="oanda", basis="bid", received_at=NOW, range_start=START, range_end=NOW-5000,
                ranges=[dict(start=START, end=NOW-5000)])))
    with s.engine.begin() as conn:
        conn.execute(text("ANALYZE"))
    write_json("fixture.json", dict(seed=13, start=START, now=NOW, identities=IDENTITIES, source="synthetic only",
        m1_per_identity=COUNT, audit_expected=388895, python=platform.python_version(),
        files={p: hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in
               ["backend/alerts/managed_dataset.py", "backend/alerts/market.py", "backend/alerts/chart_data.py", "requirements.lock"]}))
    print("fixture seeded", flush=True)


def snapshot():
    with s.transaction() as db:
        return dict(publications=[dict(instrument=p.instrument_id, frame=p.timeframe, start=p.start, end=p.end,
            count=p.complete_count, revision=p.revision, initialized=p.initialized) for p in db.scalars(
            select(s.ChartPublication).order_by(s.ChartPublication.instrument_id, s.ChartPublication.timeframe))],
            published_bars=db.scalar(select(func.count()).select_from(s.ChartPublishedBar)),
            aggregation_jobs=db.scalar(select(func.count()).select_from(s.ChartAggregationJob)),
            publication_jobs=db.scalar(select(func.count()).select_from(s.ChartPublicationJob)))


def cycle():
    from alerts import chart_aggregation_worker
    if hasattr(chart_aggregation_worker, 'cycle'):
        return chart_aggregation_worker.cycle()
    return aggregate_once(), m.publish_once()


def warmup():
    # Candidate migration final verification is explicit maintenance, separated
    # from timed publisher ticks; the frozen old baseline stays unchanged.
    if hasattr(s, 'MarketCoverageCheckpoint'):
        from alerts.coverage_projection import backfill_page
        for ident in IDENTITIES:
            while True:
                with s.transaction() as db:
                    result = backfill_page(db, db.get(s.Instrument, ident), administrative=True)
                if result['complete']:
                    break
    for _ in range(2 * len(IDENTITIES) * len(m.FRAMES)):
        cycle()
    if hasattr(s, 'ChartPublicationState'):
        for _ in range(2000):
            with s.transaction() as db:
                pending = db.scalar(select(func.count()).select_from(s.ChartPublicationState).where(
                    s.ChartPublicationState.requested > s.ChartPublicationState.processed))
            if not pending:
                break
            cycle()
        else:
            raise AssertionError('Candidate warmup did not drain durable publication requests')
        with s.transaction() as db:
            assert not db.scalar(select(func.count()).select_from(s.ChartAggregationJob))
            assert not db.scalar(select(func.count()).select_from(s.ChartPublicationJob))
            assert db.scalar(select(func.count()).select_from(s.ChartPublication)) == len(IDENTITIES) * len(m.FRAMES)
    write_json("warmup.json", snapshot())
    freeze()
    print("warmup complete", flush=True)


def freeze():
    with s.engine.begin() as conn:
        for name in fixture_tables():
            conn.execute(text(f'CREATE TABLE fixture_{name} AS TABLE {name}'))
        conn.execute(text('CHECKPOINT'))
    print("initial publication saved", flush=True)


def reset():
    """Restore canonical synthetic source and saved initial publication between runs."""
    global clock
    clock=NOW
    with s.engine.begin() as conn:
        names = fixture_tables()
        conn.execute(text('TRUNCATE chart_aggregation_jobs, chart_publication_jobs, ' + ','.join(names)))
        for name in names:
            conn.execute(text(f'INSERT INTO {name} SELECT * FROM fixture_{name}'))
        conn.execute(text('DELETE FROM candles WHERE start<:start OR "end">:stop'),dict(start=START,stop=NOW-5000))
        conn.execute(text('DELETE FROM audit_events WHERE id>388895'))
        conn.execute(text('DELETE FROM market_data_coverage WHERE start<>:start OR "end"<>:stop'),dict(start=START,stop=NOW-5000))
        for i,ident in enumerate(IDENTITIES):
            conn.execute(text('''UPDATE candles SET open=:price,high=:price+1,low=:price-1,close=:price,
                complete=true,revision=1,received_at=:now,observed_at=:now,volume=("end"-start)/60000,
                volume_complete=true,volume_received_at=:now,volume_revision=1
                WHERE instrument_id=:ident AND (received_at<>:now OR observed_at<>:now OR volume_received_at<>:now OR revision<>1 OR volume_revision<>1)'''),
                dict(ident=ident,price=i+100,now=NOW))
        # Serial sequences are not part of source identity but keep audit fixture IDs stable.
        conn.execute(text("SELECT setval(pg_get_serial_sequence('audit_events','id'),388895)"))
    expected=json.loads((ROOT/'warmup.json').read_text())
    assert snapshot()==expected,'fixture reset differs from warmup'
    print('canonical fixture restored',flush=True)


def injection(scenario, sequence):
    global clock
    clock = NOW + sequence*MINUTE
    ident = IDENTITIES[sequence % len(IDENTITIES)]
    start = NOW-5000 + (sequence//len(IDENTITIES))*MINUTE
    with s.transaction() as db:
        inst = db.get(s.Instrument, ident)
        if scenario == "live":
            bar = db.scalar(select(s.Bar).where(s.Bar.instrument_id==ident, s.Bar.timeframe=="M1").order_by(s.Bar.start.desc()).limit(1))
            if sequence % 2 == 0:
                # Same-price later observation must still reach the published payload.
                write_bars(db, ident, "M1", [bar.candle()], observed_at=clock)
                return dict(instrument=ident, start=bar.start, expected_observed=clock, kind="observation")
            raw = dict(timestamp=start, open=str(bar.close), high=str(bar.close+1), low=str(bar.close-1), close=str(bar.close), complete=True, volume=1)
            ingest(db, inst, dict(source=inst.source, basis=inst.basis, rows=[raw], coverage=[dict(start=bar.end, end=start+MINUTE)]),
                   received_at=clock+MINUTE+5000, defer_aggregation=True)
            return dict(instrument=ident, start=start, expected_close=str(bar.close), kind="new_bar")
        if scenario == "revision":
            target = START+(COUNT-1500+sequence%100)*MINUTE
            bar = db.scalar(select(s.Bar).where(s.Bar.instrument_id==ident, s.Bar.timeframe=="M1", s.Bar.start==target))
            close = bar.close + Decimal("0.01")
            updated = replace(bar.candle(), high=bar.high+Decimal("0.01"), close=close, volume=bar.volume+1)
            write_bars(db, ident, "M1", [updated], observed_at=clock)
            from alerts.chart_aggregation import enqueue_aggregation
            enqueue_aggregation(db, ident, target, target+MINUTE, clock)
            return dict(instrument=ident, start=target, expected_close=str(close), expected_volume=str(updated.volume), kind="revision")
    return None


def matched(expected):
    with s.transaction() as db:
        row = db.get(s.ChartPublishedBar, (expected["instrument"], "M1", expected["start"]))
        if row is None:
            return False
        if "expected_observed" in expected:
            return row.payload.get("observed_at",0) >= expected["expected_observed"]
        return (Decimal(row.payload["close"]) == Decimal(expected["expected_close"]) and
                ("expected_volume" not in expected or Decimal(row.payload["volume"]) == Decimal(expected["expected_volume"])))


def measure(scenario, seconds, repetition, *, drain_seconds=0):
    global clock
    clock = NOW
    m._PUBLISH_CURSOR = None
    queries = Counter()
    sql_seconds = 0
    statement_start = 0
    scope = "worker"
    def before(conn,cursor,statement,params,context,many):
        nonlocal statement_start
        statement_start = time.monotonic()
        if scope != "worker":
            return
        queries["total"] += 1
        for token, label in (("FROM candles","candle_reads"),("FROM audit_events","audit_reads"),
                             ("FROM market_data_coverage","coverage_reads"),("UPDATE chart_publications","publication_updates"),
                             ("INSERT INTO chart_published_bars","snapshot_insert_statements")):
            if token in statement:
                queries[label] += 1
    def after(*args):
        nonlocal sql_seconds
        if scope == "worker":
            sql_seconds += time.monotonic()-statement_start
    before_state = snapshot()
    def cgroup():
        paths=['cpu.stat','memory.current','memory.events','io.stat']
        return {p:(Path('/sys/fs/cgroup')/p).read_text() for p in paths if (Path('/sys/fs/cgroup')/p).exists()}
    cgroup_before=cgroup()
    with s.engine.begin() as conn:
        conn.execute(text('SELECT pg_stat_statements_reset()'))
    if scenario == "backfill":
        with s.transaction() as db:
            for ident in IDENTITIES:
                inst = db.get(s.Instrument, ident)
                m.join(db, inst, START, NOW)
    event.listen(s.engine,"before_cursor_execute",before)
    event.listen(s.engine,"after_cursor_execute",after)
    begun, cpu_begun = time.monotonic(), time.process_time()
    pending, completed, turns = [], [], []
    ready_since = {}
    sequence, next_input = 0, begun
    raw = ROOT / f"{scenario}-{repetition}.jsonl"
    with raw.open("w") as output:
        while time.monotonic()-begun < seconds+drain_seconds:
            elapsed_window=time.monotonic()-begun
            if elapsed_window >= seconds:
                with s.transaction() as db:
                    due=db.scalar(select(func.count()).select_from(s.ChartPublicationState).where(
                        s.ChartPublicationState.requested>s.ChartPublicationState.processed,
                        s.ChartPublicationState.next_at<=clock))
                if not due and not pending:
                    break
            if elapsed_window < seconds and scenario in ("live", "revision") and time.monotonic() >= next_input:
                scope = "input"
                sequence += 1
                item = injection(scenario, sequence)
                item["committed_seconds"] = time.monotonic()-begun
                pending.append(item)
                next_input = time.monotonic()+10
            # Measure runnable wait, excluding quiet targets waiting for new
            # evidence. Legacy rotation had every target perpetually runnable.
            scope = 'verification'
            with s.transaction() as db:
                ready = set(db.execute(select(s.ChartPublicationState.instrument_id,
                    s.ChartPublicationState.timeframe).where(
                    s.ChartPublicationState.requested > s.ChartPublicationState.processed,
                    s.ChartPublicationState.next_at <= clock)).all())
            at = time.monotonic()
            ready_since = {key: ready_since.get(key, at) for key in ready}
            scope = "worker"
            t = time.monotonic()
            a,p = cycle()
            elapsed = time.monotonic()-t
            target = getattr(p, 'selected_target', None) or (m._PUBLISH_CURSOR if p else None)
            completed_at = time.monotonic()
            ages = {key: completed_at - value for key, value in ready_since.items()}
            age = completed_at-ready_since.get(target, completed_at) if target else 0
            age = max(0, age)
            wait_to_start = max(0, t-ready_since.get(target, t)) if target else 0
            if target:
                ready_since[target] = time.monotonic()
            turn = dict(at=completed_at-begun, seconds=elapsed, aggregate=a,
                        publish_claim=bool(p) or getattr(p, 'attempted', False),
                        target=target, target_wait=age,
                        target_wait_to_start=wait_to_start,
                        ready_targets=len(ready), queries=dict(queries),
                        ready_ages=[dict(target=list(key), seconds=value) for key,value in sorted(ages.items())],
                        longest_ready_age=max(ages.values(), default=0))
            turns.append(turn)
            output.write(json.dumps(turn)+"\n")
            output.flush()
            scope = "verification"
            for item in pending[:]:
                if matched(item):
                    completed.append(dict(**item, latency_seconds=time.monotonic()-begun-item["committed_seconds"]))
                    pending.remove(item)
            time.sleep(wait_seconds(a, p))
    final_at = time.monotonic()
    with s.transaction() as db:
        final_ready = set(db.execute(select(s.ChartPublicationState.instrument_id,
            s.ChartPublicationState.timeframe).where(
            s.ChartPublicationState.requested > s.ChartPublicationState.processed,
            s.ChartPublicationState.next_at <= clock)).all())
    unresolved = [dict(target=list(key), seconds=final_at-ready_since.get(key, final_at),
                       right_censored=True) for key in sorted(final_ready)]
    duration, cpu = time.monotonic()-begun, time.process_time()-cpu_begun
    event.remove(s.engine,"before_cursor_execute",before)
    event.remove(s.engine,"after_cursor_execute",after)
    after_state = snapshot()
    with s.engine.begin() as conn:
        pg_stats=[dict(r) for r in conn.execute(text('''SELECT query,calls,total_exec_time,rows,shared_blks_hit,
            shared_blks_read,temp_blks_read,temp_blks_written,blk_read_time,blk_write_time
            FROM pg_stat_statements ORDER BY total_exec_time DESC''')).mappings()]
        db_stats=dict(conn.execute(text("SELECT * FROM pg_stat_database WHERE datname='issue13'")).mappings().one())
    write_json(f'{scenario}-{repetition}-sql.json',dict(statements=pg_stats,database=db_stats,
        note='Includes fixture input and verification, not just worker queries. pg_stat_database is cumulative.'))
    ordered = sorted(t["seconds"] for t in turns)
    latencies = sorted(c["latency_seconds"] for c in completed)
    def percentile(values,p):
        return values[min(len(values)-1,int((len(values)-1)*p))] if values else None
    result = dict(scenario=scenario,repetition=repetition,duration=duration,process_cpu_seconds=cpu,
        nominal_input_window_seconds=seconds,drain_limit_seconds=drain_seconds,
        process_cpu_percent=100*cpu/duration, cpu_scope="worker + injection + verification in one capped process",
        queries=dict(queries),worker_sql_seconds=sql_seconds,cycles=len(turns),
        cycle_p50=percentile(ordered,.5),cycle_p95=percentile(ordered,.95),cycle_p99=percentile(ordered,.99),
        events=completed,unpublished_events=pending,latency_p50=percentile(latencies,.5),latency_p95=percentile(latencies,.95),latency_p99=percentile(latencies,.99),
        longest_target_wait=max([t['longest_ready_age'] for t in turns] +
                                [row['seconds'] for row in unresolved] + [0]),
        final_unserved_ready=unresolved,
        before=before_state, after=after_state, visible_unchanged=before_state==after_state,
        backfill_bars_per_second=(after_state["published_bars"]-before_state["published_bars"])/duration,
        limitation="No API/alert/browser process; synthetic sources, warm cache; host contention sampled separately")
    result['cgroup_before'],result['cgroup_after']=cgroup_before,cgroup()
    if scenario == "idle":
        assert result["visible_unchanged"] and not before_state["aggregation_jobs"] and not before_state["publication_jobs"], "not a truly idle fixture"
    write_json(f"{scenario}-{repetition}.json",result)
    print(json.dumps({k:result[k] for k in ("scenario","repetition","cycles","process_cpu_percent","queries","latency_p95","longest_target_wait")}),flush=True)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("action",choices=["setup","warmup","freeze","reset","measure"])
    parser.add_argument("--scenario",choices=["idle","live","backfill","revision"],default="idle")
    parser.add_argument("--seconds",type=int,default=300)
    parser.add_argument("--repetition",type=int,default=1)
    args=parser.parse_args()
    ROOT.mkdir(exist_ok=True)
    if args.action=="setup": setup()
    elif args.action=="warmup": warmup()
    elif args.action=="reset": reset()
    elif args.action=="freeze": freeze()
    else: measure(args.scenario,args.seconds,args.repetition)


if __name__=="__main__": main()
