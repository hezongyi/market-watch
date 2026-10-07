"""CSV encoding for already validated chart pages; no vendor export dependency."""

import csv
import io
import json
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
    fixed = page.get("series_kind") in ("history", "composite")
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
            "volume_kind",
            "volume_unit",
            "volume_complete",
            *(["source", "raw_symbol", "adjustment"] if page.get("source") == "yahoo" else []),
            *(["series_kind", "history_version_id", "composite_revision_id", "input_revision",
               "time_closed", "source_confirmed", "coverage_complete", "segments"] if fixed else []),
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
                    page.get("volume_kind", "unavailable"),
                    page.get("volume_unit"),
                    str(bar.get("volume_complete", False)).lower(),
                    *([page["source"], page["symbol"], page["adjustment"]] if page.get("source") == "yahoo" else []),
                    *([page["series_kind"], page.get("history_version_id", page.get("version_id")),
                       page.get("revision_id"), page.get("input_revision"),
                       str(bar.get("time_closed", False)).lower(),
                       str(bar.get("source_confirmed", False)).lower(),
                       str(bar.get("coverage_complete", False)).lower(),
                       json.dumps(bar.get("segments", []), sort_keys=True, ensure_ascii=False)] if fixed else []),
                    *[values.get(bar["start"]) for _, values in columns],
                ]
            ]
        )
    return ("\ufeff" + stream.getvalue()).encode("utf-8")
