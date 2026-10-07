"""Generate genuine fixed-input reader results from disposable test state."""

import json

import pytest
from alerts import storage
from alerts.chart_api import DataQuery, data_sync
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from test_composite_chart import populated
from test_fixed_series_revisions import correction

engine = create_engine("sqlite://", poolclass=StaticPool)
storage.bootstrap(engine)
factory = sessionmaker(engine, expire_on_commit=False)
patch = pytest.MonkeyPatch()
patch.setattr(storage, "Session", factory)
try:
    composite, revision, seam = populated(factory, patch)
    query = DataQuery(instrument=composite, series_kind="composite", timeframe="M1",
        limit=2000, track_history=True, revision_after=0, provisional=False)
    initial = data_sync(query)
    query.revision_before = initial["history_check"]["next_before"]
    with factory.begin() as db:
        correction(db, revision, seam + 600000, 200001000)
    appended = data_sync(query)
    query.revision_before = appended["history_check"]["next_before"]
    with factory.begin() as db:
        correction(db, revision, seam + 60000, 200002000, "1.115")
    corrected = data_sync(query)
    print(json.dumps(dict(start=seam, ticker="MWC:" + composite, initial=initial,
        appended=appended, corrected=corrected)))
finally:
    patch.undo()
    engine.dispose()
