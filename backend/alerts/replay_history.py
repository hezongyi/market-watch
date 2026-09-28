"""Compressed immutable warmup, streamed without a large Python history list."""

import gzip
import json
from io import BytesIO


def pack_history(rows):
    buffer = BytesIO()
    count = 0
    with gzip.GzipFile(fileobj=buffer, mode="wb", mtime=0) as stream:
        for row in rows:
            stream.write(json.dumps(row, separators=(",", ":")).encode() + b"\n")
            count += 1
    return buffer.getvalue(), count


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
