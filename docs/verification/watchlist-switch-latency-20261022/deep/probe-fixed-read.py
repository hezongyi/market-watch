"""Profile real fixed reads in one private process, rolling back every outer transaction."""
import collections
import functools
import json
import re
import time

from sqlalchemy import event, text
from alerts import chart_api, composite_chart, display_snapshots, fixed_indicators
from alerts import fixed_indicator_display, history_artifacts, indicator_demands, market_data, series_access
from alerts.storage import Session, engine, now_ms

stack=[]
spans=[]
queries=[]


def observe(module, name):
    original=getattr(module,name)
    label=module.__name__.rsplit('.',1)[-1]+'.'+name
    @functools.wraps(original)
    def measured(*args,**kwargs):
        start=time.perf_counter()
        row={'name':label,'parent':stack[-1] if stack else None}
        stack.append(label)
        try:
            return original(*args,**kwargs)
        except Exception as error:
            row['error_type']=type(error).__name__
            raise
        finally:
            stack.pop()
            row['ms']=round((time.perf_counter()-start)*1000,3)
            spans.append(row)
    setattr(module,name,measured)


for module,names in [
    (series_access,['metadata','chart_data','history_check']),
    (history_artifacts,['chart_page','read_artifact']),
    (composite_chart,['chart_page']),
    (display_snapshots,['capture','renew']),
    (indicator_demands,['warm_defaults','renew','guard']),
    (fixed_indicators,['request','checkpoint_before']),
    (market_data,['renew_demand']),
    (fixed_indicator_display,['prepare']),
]:
    for name in names:
        observe(module,name)


@event.listens_for(engine,'before_cursor_execute')
def before(connection,cursor,statement,parameters,context,many):
    context.mwlat_start=time.perf_counter()


@event.listens_for(engine,'after_cursor_execute')
def after(connection,cursor,statement,parameters,context,many):
    tables=sorted(set(re.findall(r'\b(?:FROM|JOIN|UPDATE|INTO)\s+([a-z_][a-z_0-9]*)',statement,re.I)))
    label='advisory:8675313' if '8675313' in statement else 'advisory:8675310' if '8675310' in statement else ','.join(tables) or statement.split()[0]
    queries.append({'label':label,'parent':stack[-1] if stack else None,'ms':round((time.perf_counter()-context.mwlat_start)*1000,3)})


cases=[('history','2a673b63-2922-497e-bec9-d0231be55934','H1',77),
       ('composite','8c490df00408ed7102d9106e2ad6d3991d3e6488de0b0905d92a2ec052343cbb','H1',77),
       ('composite','8c490df00408ed7102d9106e2ad6d3991d3e6488de0b0905d92a2ec052343cbb','H4',46)]
for repeat in range(2):
    for kind,ident,frame,count in cases:
        spans.clear();queries.clear()
        started=time.perf_counter()
        row={'at':now_ms(),'repeat':repeat,'kind':kind,'frame':frame,'count':count,'transaction':'rolled_back'}
        try:
            with Session() as db:
                db.execute(text("SET LOCAL statement_timeout='5000ms'"))
                db.execute(text("SET LOCAL lock_timeout='2500ms'"))
                body=chart_api.DataQuery(instrument=ident,series_kind=kind,timeframe=frame,
                    limit=count,before=now_ms()+60000,client='mwlat-private-rollback-20261022')
                try:
                    page=series_access.chart_data(db,body)
                    fixed_indicator_display.prepare(db,page,body)
                    row.update(bars=len(page['bars']),display_snapshot=bool(page.get('display_snapshot_id')),
                               input_revision=page.get('input_revision'),pending=page.get('pending'))
                finally:
                    db.rollback()
        except Exception as error:
            row['error_type']=type(error).__name__
        row['elapsed_ms']=round((time.perf_counter()-started)*1000,3)
        row['spans']=list(spans)
        aggregate=collections.defaultdict(lambda:{'count':0,'ms':0})
        for query in queries:
            item=aggregate[(query['label'],query['parent'])]
            item['count']+=1;item['ms']+=query['ms']
        row['queries']=[{'label':key[0],'parent':key[1],'count':value['count'],'ms':round(value['ms'],3)}
                        for key,value in sorted(aggregate.items(),key=lambda entry:-entry[1]['ms'])]
        print(json.dumps(row,ensure_ascii=False),flush=True)
        time.sleep(.2)
