"""Ten explicit synthetic identities, all nine periods, sustained focused input."""
import json
import time
from pathlib import Path

from sqlalchemy import select

import pg_baseline as b
from alerts.publication_schedule import RULES, request

s, m = b.s, b.m
ROOT = Path('/results/fairness')


def main():
    if ROOT.exists():
        raise SystemExit('Fairness evidence exists; preserve it before any intentional new run')
    ROOT.mkdir()
    b.reset()
    begun = time.monotonic()
    clock = lambda: b.NOW + int(1000 * (time.monotonic() - begun))
    m.now_ms = clock
    s.now_ms = clock
    with s.transaction() as db:
        db.add(s.ChartViewportDemand(id='issue13-fairness-focus', instrument_id='BTCUSDT',
            timeframe='M1', start=b.NOW-5000-120*b.MINUTE, end=b.NOW+b.MINUTE,
            warm_start=b.NOW-5000-240*b.MINUTE, focused=True, expires=b.NOW+120000))
        for ident in b.IDENTITIES:
            db.scalar(select(s.Instrument).where(s.Instrument.id == ident).with_for_update())
            request(db, ident, reason=RULES)
    expected = {(ident, frame) for ident in b.IDENTITIES for frame in m.FRAMES}
    ready_at = time.monotonic()
    service, turns, next_input = {}, [], 0
    last_service = {key:ready_at for key in expected}
    rounds = {key:0 for key in expected}
    maximum = 0
    while time.monotonic() - begun < 30:
        elapsed = time.monotonic() - begun
        if elapsed >= next_input:
            with s.transaction() as db:
                db.scalar(select(s.Instrument).where(s.Instrument.id == 'BTCUSDT').with_for_update())
                row = db.scalar(select(s.Bar).where(s.Bar.instrument_id == 'BTCUSDT',
                    s.Bar.timeframe == 'M1').order_by(s.Bar.start.desc()).limit(1))
                b.write_bars(db, 'BTCUSDT', 'M1', [row.candle()], observed_at=clock())
            next_input += .5
        at = time.monotonic()
        aggregate, publication = b.cycle()
        done = time.monotonic()
        ages = {key:done-value for key,value in last_service.items()}
        maximum = max(maximum, max(ages.values()))
        if publication.task_progressed:
            target = tuple(m._PUBLISH_CURSOR)
            service.setdefault(target, done - ready_at)
            last_service[target] = done
            rounds[target] += 1
            # Keep all 90 targets logically ready across repeated full rounds;
            # this is a scheduling probe, not a backfill throughput benchmark.
            with s.transaction() as db:
                request(db, target[0], frames=(target[1],), reason=RULES)
        turns.append(dict(at=at-begun, seconds=time.monotonic()-at,
            aggregate=aggregate, publication=bool(publication),
            task_progressed=publication.task_progressed,
            target=m._PUBLISH_CURSOR if publication.task_progressed else None,
            longest_ready_age=max(ages.values())))
        time.sleep(b.wait_seconds(aggregate, publication))
    missing = sorted(expected - service.keys())
    result = dict(environment='Ubuntu isolated PostgreSQL; 0.75 CPU worker / 0.75 CPU PG',
        synthetic_identities=b.IDENTITIES, frames=list(m.FRAMES), targets=len(expected),
        focused_identity='BTCUSDT', service=[dict(instrument=i, frame=f, seconds=v)
            for (i,f),v in sorted(service.items())], missing=missing,
        longest_first_service_seconds=max(service.values(), default=0), turns=turns,
        longest_target_wait=maximum, rounds=[dict(target=key,count=value) for key,value in sorted(rounds.items())],
        ready_committed_seconds=ready_at-begun,
        scope='Runnable 10x9 target selection under continuous same-price focus input; not provider latency')
    (ROOT/'result.json').write_text(json.dumps(result, indent=2)+'\n')
    assert not missing, 'Runnable identity/period starved'
    assert result['longest_first_service_seconds'] <= 10, 'Runnable fairness gate exceeded'
    assert maximum <= 10 and min(rounds.values()) >= 2, 'Sustained rotation gate exceeded'
    print('All 90 runnable targets served within 10s under continuous focused input')


if __name__ == '__main__':
    main()
