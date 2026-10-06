"""Export whitelisted coverage evidence from existing production, SELECT only.

No new instance/files on unraid; read-only repeatable-read transaction with
statement timeouts. Credentials stay inside existing app settings, never output.
Interval comparison runs separately on Ubuntu. Do not use this to authorize
production changes or claim a PostgreSQL migration rehearsal has passed.
"""
import json
import shlex
import subprocess
from pathlib import Path

HERE=Path(__file__).resolve().parent
REMOTE=r'''
import json,sys
from sqlalchemy import select,text
from alerts import storage as s
try:
    with s.engine.connect().execution_options(isolation_level="REPEATABLE READ") as connection:
        with connection.begin():
            connection.execute(text("SET TRANSACTION READ ONLY"))
            connection.execute(text("SET LOCAL statement_timeout='5s'"))
            connection.execute(text("SET LOCAL lock_timeout='1s'"))
            clock=connection.execute(text("SELECT extract(epoch from transaction_timestamp())*1000")).scalar()
            print(json.dumps(dict(kind="metadata",at_ms=int(clock),scope="official production SELECT snapshot; no writes")),flush=True)
            identities=list(connection.execute(select(s.Instrument.id,s.Instrument.source,s.Instrument.basis).where(s.Instrument.source=="oanda")).mappings())
            ids=[row["id"] for row in identities]
            for row in identities: print(json.dumps(dict(kind="instrument",**dict(row))),flush=True)
            if ids:
                statement=select(s.Audit.id,s.Audit.details).where(s.Audit.kind=="provider_query_coverage",s.Audit.details["instrument"].as_string().in_(ids))
                for row in connection.execution_options(stream_results=True).execute(statement).mappings():
                    details=row["details"]
                    fields={k:details[k] for k in ("instrument","source","basis","received_at","range_start","range_end","ranges") if k in details}
                    print(json.dumps(dict(kind="audit",id=row["id"],details=fields)),flush=True)
                statement=select(s.MarketCoverage.instrument_id,s.MarketCoverage.source,s.MarketCoverage.basis,s.MarketCoverage.start,s.MarketCoverage.end,s.MarketCoverage.queried_at).where(s.MarketCoverage.instrument_id.in_(ids))
                for row in connection.execution_options(stream_results=True).execute(statement).mappings():
                    print(json.dumps(dict(kind="coverage",**dict(row))),flush=True)
            print(json.dumps(dict(kind="complete",instruments=len(ids))),flush=True)
except Exception as error:
    print("Read-only coverage export failed: "+type(error).__name__,file=sys.stderr)
    sys.exit(1)
'''


def main():
    target=HERE/'production-coverage.jsonl'
    if target.exists() or target.with_suffix('.jsonl.gz').exists():
        raise SystemExit('Existing evidence retained; deliberately archive before resampling')
    command=['ssh','-o','BatchMode=yes','-o','ConnectTimeout=10','unraid',
        shlex.join(['docker','exec','-i','market-watch-chart-aggregation-worker-1','python','-'])]
    with target.open('w') as output:
        proc=subprocess.run(command,input=REMOTE,text=True,stdout=output,stderr=subprocess.PIPE,timeout=120)
    if proc.returncode:
        print(proc.stderr.strip())
        raise SystemExit('Export incomplete; retain file and do not use as a complete snapshot')
    with target.open() as source:
        counts={}
        last=None
        for line in source:
            last=json.loads(line)
            counts[last['kind']]=counts.get(last['kind'],0)+1
    assert last and last['kind']=='complete','no terminal snapshot marker'
    print(json.dumps(dict(records=counts,bytes=target.stat().st_size,environment='read-only production snapshot exported to Ubuntu')))


if __name__=='__main__': main()
