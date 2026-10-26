"""Read-only decoder for retained historical replay snapshots."""

import gzip
import json
from io import BytesIO


def history_rows(run, *, until=None):
    """Legacy replays keep history in bars; new ones split warmup and event range."""
    cutoff = run.cursor if until is None else until
    if run.warmup_snapshot is not None:
        with gzip.GzipFile(fileobj=BytesIO(run.warmup_snapshot), mode="rb") as stream:
            for line in stream:
                row = json.loads(line)
                if row["end"] > cutoff:
                    return
                yield row
    for row in run.bars:
        if row["end"] > cutoff:
            break
        if run.warmup_snapshot is None or row["end"] > run.start:
            yield row
