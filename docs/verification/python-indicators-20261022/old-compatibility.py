import json
import os
import subprocess

from alerts.chart_api import DataQuery, data_sync
from alerts.fixed_indicators import indicator_tick
from alerts.storage import Preference, transaction

assert os.environ["MW_PREVIEW_TASK"] == "mw-python-indicators-20261022"
with transaction() as db:
    version = db.get(Preference, "python_indicator_fixture:EURUSD").value["version"]
query = dict(
    instrument=version,
    series_kind="history",
    timeframe="D1",
    limit=30,
    indicators=[{"name": "EMA", "params": {"period": 5}}],
)
old = data_sync(DataQuery(**query))
strict_id = old["indicator_progress"][0]["run_id"]
while indicator_tick(strict_id):
    pass
expected = data_sync(DataQuery(**query))["indicators"][0]["series"]
observed = data_sync(DataQuery(**query, indicator_input_policy="observed_display_v1"))
observed_id = observed["indicator_progress"][0]["run_id"]
code = """import json,sys
from alerts.chart_api import DataQuery,data_sync
from alerts.fixed_indicators import claim
body=json.load(sys.stdin)
assert claim(body['observed_id']) is None
result=data_sync(DataQuery(**body['query']))
assert result['indicators'][0]['series']==body['expected']
print(json.dumps({'old_worker_excludes_observed':True,'strict_series_unchanged':True,'old_application':'v1.26.5'}))
"""
result = subprocess.run(
    ["python", "-c", code],
    input=json.dumps(dict(query=query, expected=expected, observed_id=observed_id)),
    env={**os.environ, "PYTHONPATH": "/tmp/old-code"},
    capture_output=True,
    text=True,
    cwd="/tmp",
)
print(result.stdout)
print(result.stderr[-1000:])
raise SystemExit(result.returncode)
