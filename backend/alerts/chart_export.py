"""CSV encoding for already validated chart pages; no vendor export dependency."""

import csv
import io
from datetime import UTC, datetime


def _cell(value):
    if value is None:
        return ""
    # Labels can come from user-managed plugins/workspaces. Prevent spreadsheet formulas.
    if isinstance(value, str) and value.lstrip().startswith(("=", "+", "-", "@")):
        try:
            float(value)
        except ValueError:
            return "'" + value
    return value


def chart_csv(page, *, instrument, timeframe):
    """Encode a complete requested page, preserving backend timestamps and precision.

    The caller must verify historical coverage before offering a download. Missing
    indicator warmup values remain blank, and unavailable volume is not invented.
    """
    columns = []
    for index, indicator in enumerate(page.get("indicators", []), 1):
        for series in indicator["series"]:
            label = f"python:{index}:{indicator.get('id', indicator['name'])}:{series['key']}"
            columns.append((label, {v["time"]: v["value"] for v in series["values"]}))
    stream = io.StringIO(newline="")
    writer = csv.writer(stream)
    writer.writerow(
        [
            "instrument",
            "timeframe",
            "basis",
            "calendar",
            "start_utc",
            "end_utc",
            "start_ms",
            "end_ms",
            "open",
            "high",
            "low",
            "close",
            "volume",
            "complete",
            "revision",
            *[name for name, _ in columns],
        ]
    )
    previous = None
    for bar in page["bars"]:
        if previous is not None and bar["start"] <= previous:
            raise ValueError("Export bars must be strictly chronological and unique")
        previous = bar["start"]

        def iso(stamp):
            return datetime.fromtimestamp(stamp / 1000, UTC).isoformat(timespec="milliseconds")

        writer.writerow(
            [
                _cell(v)
                for v in [
                    instrument,
                    timeframe,
                    page["basis"],
                    page["calendar"],
                    iso(bar["start"]),
                    iso(bar["end"]),
                    bar["start"],
                    bar["end"],
                    *[bar[k] for k in ("open", "high", "low", "close")],
                    bar.get("volume"),
                    str(bar["complete"]).lower(),
                    bar.get("revision"),
                    *[values.get(bar["start"]) for _, values in columns],
                ]
            ]
        )
    return ("\ufeff" + stream.getvalue()).encode("utf-8")
