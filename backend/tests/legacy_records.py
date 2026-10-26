"""Construct archived predecessor records only for persistence compatibility tests."""

import gzip
import json
from io import BytesIO

from alerts.storage import HistoryVersion, Replay


def create_replay(db, instrument, version_id, frame, start, end):
    """Insert a fixed archived record; no retired replay application behavior."""
    version = db.get(HistoryVersion, version_id)
    rows = [{"start": start, "end": end, "open": "1", "high": "1", "low": "1", "close": "1"}]
    run = Replay(instrument_id=instrument.id, dataset_version=version_id,
        input_manifest=dict(version.manifest), calendar_profile=instrument.calendar_profile,
        timeframe=frame, start=start, end=end, cursor=start, bars=rows,
        warmup_snapshot=None, warmup_count=0, days=[], watches=[], signals=[])
    db.add(run)
    db.flush()
    return run



def pack_history(rows):
    buffer = BytesIO()
    count = 0
    with gzip.GzipFile(fileobj=buffer, mode="wb", mtime=0) as stream:
        for row in rows:
            stream.write(json.dumps(row, separators=(",", ":")).encode() + b"\n")
            count += 1
    return buffer.getvalue(), count




def archived_watch(db, instrument, name, rule, *, armed_at=0, use_history=False):
    """Insert a historical record without any retired application behavior."""
    from alerts.storage import Watch
    row = Watch(instrument_id=instrument, name=name, rule=rule, armed_at=armed_at,
                warmup_start=armed_at, status="active", state={"saved": "historical evidence"})
    db.add(row)
    db.flush()
    return row
