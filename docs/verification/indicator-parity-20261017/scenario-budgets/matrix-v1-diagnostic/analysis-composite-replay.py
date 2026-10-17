"""Task-local diagnostic replay; no application source instrumentation."""
import contextlib
import copy
import cProfile
import functools
import io
import json
import pstats
import re
import time
from collections import defaultdict
from pathlib import Path

from fastapi.encoders import jsonable_encoder
from starlette.responses import JSONResponse
from sqlalchemy import event
from alerts import chart_api, chart_indicators, fixed_indicator_display, fixed_indicators
from alerts import history_artifacts, indicator_demands, series_access, storage, composite_chart, display_indicators, composite_series

base = dict(instrument='2bcbc81d8e0e33b2318774f24638e2327448c8d3ecae8d190915cb94b50f637b',series_kind='composite',timeframe='M1',provisional=True,before=1791493140001,limit=636,dependency_before=1791455040000)
spans = defaultdict(list)
queries = []

def wrap(module, name):
    original = getattr(module, name)
    @functools.wraps(original)
    def measured(*args, **kwargs):
        started = time.perf_counter()
        try:
            return original(*args, **kwargs)
        finally:
            spans[module.__name__.split('.')[-1]+'.'+name].append((time.perf_counter()-started)*1000)
    setattr(module, name, measured)

for module, names in [
    (composite_chart, ['chart_page','read_artifact']),
    (display_indicators, ['suffix']),
    (composite_series, ['read_window']),
    (series_access, ['chart_data','metadata','history_check','future_grid']),
    (history_artifacts, ['chart_page','read_artifact','published_artifact']),
    (indicator_demands, ['guard','renew']),
    (fixed_indicators, ['request','outputs','_context','input_rows','read_artifact','calculate_inputs','presentation']),
    (fixed_indicator_display, ['prepare','complete','presentation']),
    (chart_indicators, ['calculate']),
]:
    for name in names:
        wrap(module, name)

original_transaction = chart_api.transaction
@contextlib.contextmanager
def measured_transaction():
    total = time.perf_counter()
    with original_transaction() as db:
        opened = time.perf_counter()
        yield db
        spans['transaction.body'].append((time.perf_counter()-opened)*1000)
        closing = time.perf_counter()
    spans['transaction.commit_exit'].append((time.perf_counter()-closing)*1000)
    spans['transaction.total'].append((time.perf_counter()-total)*1000)
chart_api.transaction = measured_transaction

@event.listens_for(storage.engine, 'before_cursor_execute')
def before_sql(conn, cursor, statement, parameters, context, executemany):
    context.analysis_start = time.perf_counter()

@event.listens_for(storage.engine, 'after_cursor_execute')
def after_sql(conn, cursor, statement, parameters, context, executemany):
    tables = sorted(set(re.findall(r'(?i)(?:from|into|update|join)\s+([a-z_][a-z_0-9]*)',statement)))
    queries.append({'kind':statement.split(None,1)[0], 'tables':tables,
                    'advisory':'pg_advisory' in statement,
                    'ms':round((time.perf_counter()-context.analysis_start)*1000,3),
                    'rowcount':cursor.rowcount})

output=[]
for index, period in enumerate([451,452,453,454,455,455]):
    query=copy.deepcopy(base)
    query['client']='issue74-analysis-replay'
    query['indicators']=[{'name':'EMA','params':{'period':period}}]
    query['indicator_consumers']=[{'id':'diagnostic-replay','generation':index+1,'spec':query['indicators'][0]}]
    body=chart_api.DataQuery.model_validate(query)
    spans.clear();queries.clear()
    profiler=cProfile.Profile()
    if index==2:profiler.enable()
    started=time.perf_counter()
    page=chart_api.data_sync(body)
    calculated=time.perf_counter()
    encoded=jsonable_encoder(page)
    encoding=time.perf_counter()
    payload=JSONResponse(encoded).body
    finished=time.perf_counter()
    if index==2:
        profiler.disable()
        buffer=io.StringIO()
        pstats.Stats(profiler,stream=buffer).strip_dirs().sort_stats('cumulative').print_stats(35)
        print('CPROFILE_BEGIN\n'+buffer.getvalue()+'CPROFILE_END',flush=True)
    output.append({'period':period,'cprofile_enabled':index==2,
        'data_sync_ms':round((calculated-started)*1000,3),
        'jsonable_encoder_ms':round((encoding-calculated)*1000,3),
        'json_render_ms':round((finished-encoding)*1000,3),
        'response_bytes':len(payload),'bars':len(page['bars']),
        'progress':page['indicator_progress'][0],
        'spans':{name:{'calls':len(values),'total_ms':round(sum(values),3),'max_ms':round(max(values),3)} for name,values in spans.items()},
        'sql':queries.copy()})
    print(json.dumps(output[-1],separators=(',',':')),flush=True)
Path('/tmp/analysis-composite-replay-result.json').write_text(json.dumps(output,indent=2)+'\n')
