"""Frozen PAIO request inputs; © fengyangsi adaptation, MPL-2.0.

Only existing same-identity datasets/artifacts are read. Missing dependencies
remain explicit null modules, never substituted prices or synthetic OHLC.
Historical lookahead_off selects the last intrabar, or a completed HTF value;
the final realtime observation may see a developing requested candle.
"""

import bisect
import hashlib
import json

from .paio_spec import FRAMES, NAME

MAX_ROWS = 250_000


NATIVE_CALENDARS = frozenset(("dukascopy_native_utc", "fxcm_native", "native"))


class PaioCalendarUnavailable(ValueError):
    """A source period is missing, rather than an alternative inferred phase."""

    def __init__(self, frame, reason="NATIVE_PERIOD_NOT_LOADED"):
        self.frame, self.reason = frame, reason
        super().__init__(f"PAIO: {frame} 原生周期边界尚未可核实 ({reason})")


def requests(specs, chart_frame, *, calendar=None):
    result = set()
    for spec in specs:
        if spec["name"] != NAME:
            continue
        from .chart_indicators import validate

        _, p = validate(spec)
        for index in (1, 2, 3):
            tf = p[f"ma_{index}_timeframe"]
            frame = chart_frame if tf in ("Chart", "") else FRAMES[tf]
            if frame != chart_frame:
                result.add(frame)
        if not p["pvBaseChart"]:
            for ordinal in ("1st", "2nd", "3rd"):
                frame = FRAMES[p[f"pv{ordinal}TF"]]
                if frame != chart_frame:
                    result.add(frame)
        if calendar in NATIVE_CALENDARS:
            # Calendar inputs also belong to the native identity, including
            # chart-based PV. A UTC/NY17 reconstruction loses broker phases.
            boundary_frames = [p["bi_timeframe"], *(p[f"pv{ordinal}TF"] for ordinal in ("1st", "2nd", "3rd"))]
            if p["pvDisplay"] == "Today":
                boundary_frames.append("1D")
            result.update(FRAMES[token] for token in boundary_frames if FRAMES[token] != chart_frame)
    return sorted(result)


def _native_close(bar, frame, phase, following=None):
    """Return known native interval endpoints, never FXCM's elapsed upper bound.

    Dukascopy's adapter explicitly defines its native intervals. FXCM source
    high-period starts retain broker phases, but its terminal ``end`` is only
    an upper bound. The next observed native start can fence an adjacent
    interval; a weekend-sized jump must not become a fabricated daily close.
    """
    if phase == "dukascopy_native_utc":
        from .provider_dukascopy import interval_end

        return interval_end(bar["start"], frame)
    if phase == "native" or frame not in ("D1", "W1", "MN"):
        return bar["end"]
    bound = {"D1": 25, "W1": 7 * 24 + 1, "MN": 31 * 24 + 1}[frame] * 3600000
    if following is not None and 0 < following["start"] - bar["start"] <= bound:
        return following["start"]
    return None


def native_boundaries(row, frame):
    """Read actual native period starts; unknown future endpoints stay null.

    ``indicator_native_periods`` is frozen alongside EMA/security inputs. No
    database/network lookup is permitted here. Same-frame chart OHLC itself is
    a valid source-period observation, even before a dependency is available.
    """
    phase = row["indicator_calendar"]
    periods = row.get("indicator_native_periods", {}).get(frame, [])
    position = bisect.bisect_right(periods, row["start"], key=lambda bar: bar["start"]) - 1
    if row.get("indicator_timeframe") == frame:
        current = row
        following_index = bisect.bisect_right(periods, row["start"], key=lambda bar: bar["start"])
    else:
        current = periods[position] if position >= 0 else None
        following_index = position + 1
        if current is not None:
            following = periods[following_index] if following_index < len(periods) else None
            close = _native_close(current, frame, phase, following)
            # An elapsed native upper bound may reject a stale prior period,
            # but it never certifies that bound as the actual source close.
            cutoff = close if close is not None else current["end"]
            if row["start"] >= cutoff:
                current = None
        if current is None and following_index < len(periods):
            candidate = periods[following_index]
            if row["start"] <= candidate["start"] < row["end"]:
                current = candidate
                following_index += 1
        if current is None:
            raise PaioCalendarUnavailable(frame)
    following = periods[following_index] if following_index < len(periods) else None
    after = periods[following_index + 1] if following_index + 1 < len(periods) else None
    return (current["start"], _native_close(current, frame, phase, following),
            _native_close(following, frame, phase, after) if following is not None else None)


def boundaries(row, tf):
    """Exchange/session boundaries, independent of the user's display timezone."""
    from .composite_series import period

    frame = FRAMES.get(tf, tf)
    phase = row.get("indicator_calendar", "utc0")
    if phase in NATIVE_CALENDARS:
        return native_boundaries(row, row.get("indicator_timeframe") if tf == "Chart" else frame)
    if tf == "Chart" or row.get("indicator_timeframe") == frame:
        left, right = row["start"], row["end"]
    elif phase == "source_date" and frame in ("D1", "W1", "MN"):
        from .history_mode_artifacts import date_bounds

        if not row.get("trading_date"):
            raise ValueError("PAIO: 来源缺少明确交易日，不能推断交易时段")
        left, right = date_bounds(row["trading_date"], frame)
    elif phase == "yahoo":
        from .nr_breakout import yahoo_period

        left, right = yahoo_period(row, {"D1": "D", "W1": "W", "MN": "M"}.get(frame, tf))
    elif phase == "source_date":
        raise ValueError("PAIO: 日线来源不能重建盘中时段边界")
    else:
        left, right = period(row["start"], frame, phase)
    if phase in ("ny17", "utc0"):
        next_left, next_end = period(right, frame, phase)
        if phase == "ny17":
            from .calendar_profile import closures_from
            from .chart_history_plan import bucket_has_trading
            from .domain import calendar_from
            from .storage import instant

            profile = row.get("indicator_calendar_profile", {})
            for _ in range(10080):  # bounded one-week M1 holiday/session search
                if bucket_has_trading(instant(next_left), instant(next_end),
                        calendar_from(phase, profile), row.get("indicator_gold", False), closures_from(profile)):
                    break
                next_left, next_end = period(next_end, frame, phase)
            else:
                raise ValueError("PAIO: 下一交易周期超出日历可确定范围")
    else:
        # Use the same calendar function at the next boundary (month/DST safe).
        probe = {**row, "start": right, "end": right + 1, "indicator_timeframe": None}
        if phase == "yahoo":
            from .nr_breakout import yahoo_period

            next_end = yahoo_period(probe, {"D1": "D", "W1": "W", "MN": "M"}.get(frame, tf))[1]
        elif phase == "source_date":
            from datetime import datetime, timezone

            from .history_mode_artifacts import date_bounds

            next_end = date_bounds(datetime.fromtimestamp(right / 1000, timezone.utc).date().isoformat(), frame)[1]
        else:
            next_end = right
    return left, right, next_end


def freeze_provider(db, dataset, specs, rows, *, as_of=None, credential=None):
    from .provider_cache import identity
    from .storage import ProviderDataset

    frozen = {}
    for frame in requests(specs, dataset.timeframe, calendar=dataset.metadata_json.get("calendar")):
        dependency = db.get(ProviderDataset, identity(dataset.metadata_json, frame))
        if dependency is None or not rows:
            frozen[frame] = dict(rows=[], revision=None, origin=None, reason="DEPENDENCY_NOT_LOADED")
            continue
        item = _provider_dependency(db, dependency, rows)
        if credential is not None:
            saved = credential.get("paio_requests", {}).get(frame)
            if not saved or saved["dataset"] != dependency.id or saved["epoch"] != item["epoch"] or (
                    isinstance(item["epoch"], list) and saved["revision"] != dependency.revision):
                from .display_snapshots import DisplaySnapshotError

                raise DisplaySnapshotError("DISPLAY_SNAPSHOT_EXPIRED", "PAIO 多周期快照已改变，请重新读取价格")
            tail = saved["tail"]
            item = {**item, "rows": [bar for bar in item["rows"] if bar["start"] < tail["start"]] + [tail],
                    "revision": [dependency.id, saved["revision"]]}
        item["rows"] = [bar for bar in item["rows"] if bar["end"] > rows[0]["start"]]
        item["origin"] = item["rows"][0]["start"] if item["rows"] else None
        frozen[frame] = item
    return dict(frames=frozen, as_of=credential.get("paio_as_of", as_of) if credential else as_of if as_of is not None else rows[-1]["end"] if rows else 0,
                last_bar_time=rows[-1]["start"] if rows else None)


def _provider_dependency(db, dataset, rows):
    from sqlalchemy import select

    from .provider_cache import check_cancelled
    from .provider_indicator_inputs import _INPUTS, Inputs, _entry, _prune
    from .storage import ProviderBar

    epoch = dataset.metadata_json.get("indicator_history_epoch") or ["legacy", dataset.revision]
    key = (db.get_bind(), "paio-request", dataset.id, rows[0]["start"])
    entry = _entry(_INPUTS, key, MAX_ROWS)
    while not entry.lock.acquire(timeout=.05):
        check_cancelled()
    try:
        previous = entry.value
        same = previous is not None and previous.epoch == epoch and previous.revision <= dataset.revision
        ceiling = rows[-1]["end"]
        if same and previous.revision == dataset.revision and previous.rows and previous.rows[-1]["end"] >= ceiling:
            loaded = previous.rows
        else:
            incremental = same and previous.rows and previous.rows[-1]["start"] < ceiling
            predecessor = previous.rows[-1]["start"] if incremental else db.scalar(select(ProviderBar.start).where(
                ProviderBar.dataset_id == dataset.id, ProviderBar.start <= rows[0]["start"])
                .order_by(ProviderBar.start.desc()).limit(1))
            suffix = list(db.scalars(select(ProviderBar.payload).where(
                ProviderBar.dataset_id == dataset.id,
                ProviderBar.start >= (predecessor if predecessor is not None else rows[0]["start"]),
                ProviderBar.start < ceiling).order_by(ProviderBar.start).limit(MAX_ROWS + 1)))
            loaded = [*previous.rows[:-1], *suffix] if incremental else suffix
            loaded = [bar for bar in loaded if bar["end"] > rows[0]["start"]]
            check_capacity(loaded)
            entry.value, entry.weight = Inputs(loaded, key, epoch, dataset.revision), len(loaded)
        return dict(rows=loaded, revision=[dataset.id, dataset.revision], epoch=epoch,
                    origin=loaded[0]["start"] if loaded else None)
    finally:
        entry.lock.release()
        _prune(_INPUTS, MAX_ROWS)


def freeze_managed(db, instrument, specs, rows, chart_frame, *, as_of=None):
    from sqlalchemy import select

    from .storage import ChartPublication, ChartPublishedBar

    frozen = {}
    for frame in requests(specs, chart_frame):
        pub = db.get(ChartPublication, (instrument, frame))
        predecessor = db.scalar(select(ChartPublishedBar.start).where(
            ChartPublishedBar.instrument_id == instrument, ChartPublishedBar.timeframe == frame,
            ChartPublishedBar.start <= rows[0]["start"]).order_by(ChartPublishedBar.start.desc()).limit(1)) if pub and rows else None
        loaded = list(db.scalars(select(ChartPublishedBar.payload).where(
            ChartPublishedBar.instrument_id == instrument, ChartPublishedBar.timeframe == frame,
            ChartPublishedBar.start >= (predecessor if predecessor is not None else rows[0]["start"]),
            ChartPublishedBar.start < rows[-1]["end"])
            .order_by(ChartPublishedBar.start).limit(MAX_ROWS + 1))) if pub and rows else []
        loaded = [bar for bar in loaded if bar["end"] > rows[0]["start"]]
        check_capacity(loaded)
        frozen[frame] = dict(rows=loaded, revision=[instrument, frame, pub.revision] if pub else None,
                             epoch=pub.revision if pub else None,
                             origin=loaded[0]["start"] if loaded else None)
    return dict(frames=frozen, as_of=as_of if as_of is not None else rows[-1]["end"] if rows else 0,
                last_bar_time=rows[-1]["start"] if rows else None)


def check_capacity(rows):
    if len(rows) > MAX_ROWS:
        raise ValueError(f"PAIO 多周期固定前缀超过 {MAX_ROWS:,} 根容量")


def fixed_identity(db, version, spec, chart_frame):
    """An absent/changed artifact must never reuse an already finished replay."""
    from sqlalchemy import select

    from .storage import HistoryArtifact

    result = []
    for frame in requests([spec], chart_frame):
        artifact = db.scalar(select(HistoryArtifact).where(
            HistoryArtifact.version_id == version.id, HistoryArtifact.timeframe == frame))
        result.append([frame, artifact.id, artifact.status, artifact.rule_version]
                      if artifact else [frame, None])
    return result


def freeze_fixed(db, run, rows, *, state=None, stamp=None, snapshot=None):
    """Read same-version artifacts/revision once per requested frame and page.

    A checkpoint's request cursors bound subsequent reads to the new suffix.
    No fallback to a provider or another fixed version is permitted.
    """
    from itertools import islice

    from sqlalchemy import select

    from .composite_aggregates import read
    from .fixed_indicators import _context
    from .history_artifacts import iter_artifact, read_artifact
    from .storage import HistoryArtifact

    version, revision, phase, _ = _context(db, run)
    frozen = {}
    state = state if state is not None else (run.state or {}).get("state", {})
    for frame in requests([run.spec], run.timeframe):
        artifact = db.scalar(select(HistoryArtifact).where(HistoryArtifact.version_id == version.id,
                                                          HistoryArtifact.timeframe == frame))
        if artifact is None or artifact.status != "published":
            frozen[frame] = dict(rows=[], revision=None, origin=None, reason="DEPENDENCY_NOT_PUBLISHED")
            continue
        left = version.start
        if rows:
            left = min(left, rows[0]["start"])
        cursors = []
        for module in ("ema", "pv"):
            for index in (1, 2, 3):
                key = f"{module}_{index}"
                p = run.spec["params"]
                tf = p[f"ma_{index}_timeframe"] if module == "ema" else p["pv" + ("1st", "2nd", "3rd")[index-1] + "TF"]
                if tf not in ("Chart", "") and FRAMES[tf] == frame:
                    cursors.append(state.get("requests", {}).get(key, {}).get("end", left))
        if cursors:
            left = min(cursors)
        stop = rows[-1]["end"] if rows else run.target_end
        from .composite_series import period

        if phase == "source_date":
            from datetime import datetime, timezone

            from .history_mode_artifacts import date_bounds

            left = date_bounds(datetime.fromtimestamp(left / 1000, timezone.utc).date().isoformat(), frame)[0]
        else:
            left = period(left, frame, phase)[0]
        seam_bucket = period(revision.seam, frame, phase)[0] if revision else version.end
        loaded = list(islice(iter_artifact(db, version.id, frame, start=left,
                               end=min(seam_bucket, stop)), MAX_ROWS+1))
        if revision and stop > seam_bucket:
            if snapshot is not None:
                from .composite_chart import chart_page

                live, before = [], stop
                floor = max(left, seam_bucket)
                for _ in range(MAX_ROWS // 2000 + 1):
                    page = chart_page(db, revision.composite_id, frame, before=before, count=2000,
                        revision_id=revision.id, provisional=True, now=stamp, display_snapshot=snapshot)
                    live.extend(bar for bar in page["bars"] if floor <= bar["start"] < stop)
                    check_capacity(live)
                    if not page["bars"] or page["bars"][0]["start"] <= floor or not page["has_more"]:
                        break
                    before = page["next_before"]
                else:
                    raise ValueError("PAIO 多周期快照分页超过容量")
                live.sort(key=lambda bar: bar["start"])
            else:
                live = read(db, revision.id, frame, run.input_revision, after=max(left, seam_bucket),
                            before=stop, count=MAX_ROWS+1, now=stamp or run.target_end, newest_first=False)
                if live is None:
                    raise TimeoutError(f"PAIO: {frame} 同修订数据尚未准备")
            loaded += live
        check_capacity(loaded)
        frozen[frame] = dict(rows=loaded, revision=[version.id, run.revision_id, run.input_revision, frame],
                             origin=version.start)
    tail = (read(db, revision.id, run.timeframe, run.input_revision, before=run.target_end,
                 count=1, now=stamp or run.target_end) if revision else
            read_artifact(db, version.id, run.timeframe, end=run.target_end, limit=1, newest_first=True))
    return dict(frames=frozen, as_of=stamp or run.target_end,
                source_end=None if revision else version.end,
                calendar_profile=version.manifest.get("calendar_profile", {}),
                last_bar_time=tail[-1]["start"] if tail else rows[-1]["start"] if rows else None)


def prepare_fixed(db, run, rows, *, state=None, stamp=None, snapshot=None):
    if run.spec["name"] != NAME or not rows:
        return rows
    frozen = freeze_fixed(db, run, rows, state=state, stamp=stamp, snapshot=snapshot)
    # Raw frozen inputs travel with this batch only, never into the checkpoint.
    return [{**rows[0], "paio_inputs": frozen}, *rows[1:]]


def attach_fixed(run, rows, phase, *, initial_state=None, provisional=False):
    if run.spec["name"] != NAME or not rows:
        return rows
    from .series_access import fixed_label

    source_end = rows[0].get("paio_inputs", {}).get("source_end")
    prepared = [{**row, "indicator_timeframe": run.timeframe, "indicator_calendar": phase,
                 # A fixed window can end inside an aggregate. Its refused
                 # tail is not a missing historical segment or a live preview.
                 "paio_terminal_partial": source_end is not None and row["start"] < source_end < row["end"],
                 "indicator_calendar_profile": rows[0].get("paio_inputs", {}).get("calendar_profile", {}),
                 "chart_time": fixed_label(row, run.timeframe, phase)} for row in rows]
    state = (run.state if initial_state is None else initial_state) or {}
    return attach(prepared, run.spec["params"], rows[0].get("paio_inputs"),
                  chart_frame=run.timeframe, provisional=provisional, state=state.get("state", {}))


def attach(rows, params, frozen=None, *, chart_frame=None, provisional=False, state=None):
    """O(chart + dependencies) request series; no query inside numerical work."""
    from .paio import source_value

    frozen = frozen or {}
    revision = hashlib.sha256(json.dumps({frame: {k: v for k, v in item.items() if k != "rows"}
        for frame, item in frozen.get("frames", {}).items()}, sort_keys=True).encode()).hexdigest()
    chart_tf = next((key for key, frame in FRAMES.items() if frame == chart_frame), None)
    dependencies = {frame: {key: value for key, value in item.items() if key != "rows"} for frame, item in frozen.get("frames", {}).items()}
    contexts = [dict(ema={}, pv={}, requests={}, dependencies=dependencies, chart_tf=chart_tf,
                     as_of=frozen.get("as_of", rows[-1]["end"] if rows else None),
                     last_bar_time=frozen.get("last_bar_time", rows[-1]["start"] if rows else None),
                     revision=revision) for _ in rows]
    for index in (1, 2, 3):
        for module in ("ema", "pv"):
            if module == "ema":
                tf, source, length = (params[f"ma_{index}_{field}"] for field in ("timeframe", "source", "length"))
            else:
                if params["pvBaseChart"]:
                    continue
                prefix = "pv" + ("1st", "2nd", "3rd")[index-1]
                tf, source = params[prefix + "TF"], params[prefix + "Source"]
                source = "close" if source == "CurrentOpen" else source
                length = None
            frame = chart_frame if tf in ("Chart", "") else FRAMES[tf]
            dependency = rows if frame == chart_frame else frozen.get("frames", {}).get(frame, {}).get("rows", [])
            prior = (state or {}).get("requests", {}).get(f"{module}_{index}", {})
            confirmed, values, starts, ends = [], [], [], []
            last = prior.get("last")
            offset = bisect.bisect_left(dependency, prior.get("end", -1), key=lambda bar: bar["start"])
            for bar in dependency[offset:]:
                if bar.get("gap_before"):
                    last = None
                value = source_value(source, {key: float(bar[key]) for key in ("open", "high", "low", "close")})
                value = value if module == "pv" or last is None else last + (value - last) * 2 / (length + 1)
                values.append(value)
                starts.append(bar["start"])
                ends.append(bar["end"])
                confirmed.append(bool(bar["complete"]))
                if bar["complete"]:
                    last = value
            # Lists refer to the retained suffix, rather than source indexes.
            cursor, last_confirmed = 0, -1
            mapped = prior.get("mapped")
            from .provider_chart import FRAME_MS

            lower = FRAME_MS.get(frame, 0) < FRAME_MS.get(chart_frame, 0)
            for row_index, row in enumerate(rows):
                # An unfinished requested bar is not a historical observation.
                previous = last_confirmed
                while cursor < len(ends) and ends[cursor] <= row["end"]:
                    if confirmed[cursor]:
                        last_confirmed = cursor
                    cursor += 1
                position = last_confirmed
                live = provisional and row_index == len(rows)-1 and not row["complete"]
                if live:
                    candidate = bisect.bisect_right(starts, min(row["end"]-1, contexts[row_index]["as_of"])) - 1
                    if candidate >= 0:
                        position = candidate
                belongs = position >= 0 and (not lower or row["start"] <= starts[position] < row["end"])
                available = belongs and (module == "pv" or live or position != previous)
                if available:
                    mapped = values[position]
                contexts[row_index][module][str(index)] = values[position] if available else mapped if module == "pv" else None
                contexts[row_index]["requests"][f"{module}_{index}"] = (
                    dict(last=values[last_confirmed], end=ends[last_confirmed], mapped=mapped) if last_confirmed >= 0 else prior)
    native_periods = {frame: item.get("rows", []) for frame, item in frozen.get("frames", {}).items()}
    if chart_frame:
        native_periods = {**native_periods, chart_frame: rows}
    return [{**row, "paio_context": context, "indicator_native_periods": native_periods}
            for row, context in zip(rows, contexts)]


def validate_presentation(value):
    """PAIO-specific schema: never relax the Swing event contract."""
    import math

    if not isinstance(value, dict) or value.get("schema") != "paio_presentation_v1" or value.get("render_profile") != "paio_v1":
        raise ValueError("PAIO: invalid presentation schema")
    objects = value.get("objects")
    if not isinstance(objects, list) or len(objects) > 1500:
        raise ValueError("PAIO: invalid object quota")
    seen, counts = set(), dict(label=0, line=0, box=0)
    for obj in objects:
        if not isinstance(obj, dict) or obj.get("kind") not in counts or not isinstance(obj.get("id"), str) or obj["id"] in seen:
            raise ValueError("PAIO: invalid object identity")
        seen.add(obj["id"])
        counts[obj["kind"]] += 1
        if counts[obj["kind"]] > 500 or type(obj.get("sequence")) is not int or type(obj.get("detected_at")) is not int:
            raise ValueError("PAIO: invalid object order/quota")
        required = {"label": ("time", "price", "bar_high", "bar_low"), "line": ("left", "right", "price"),
                    "box": ("left", "right", "top", "bottom")}[obj["kind"]]
        if any(key not in obj or obj[key] is not None and (type(obj[key]) not in (int, float) or not math.isfinite(obj[key])) for key in required):
            raise ValueError("PAIO: invalid geometry")
    return value


def chart_coordinate(stamp, row):
    frame = row.get("indicator_timeframe")
    phase = row.get("indicator_calendar", "utc0")
    if stamp is None:
        return stamp
    if phase == "native" and row.get("indicator_native_parameters"):
        from .native_series import chart_label

        return chart_label(stamp, frame, row["indicator_native_parameters"])
    if phase in NATIVE_CALENDARS:
        return stamp
    if frame not in ("D1", "W1", "MN") or phase == "source_date":
        return stamp
    from .composite_series import period
    from .series_access import fixed_label

    start, end = period(stamp, frame, phase) if phase != "yahoo" else (stamp, stamp + 1)
    return fixed_label(dict(start=start, end=end), frame, phase)


def prepare_provider(meta, specs, chart_frame, before, count, *, origin=None, latest=False):
    """Use existing finite read budgets and native-history resumable tasks.

    A missing cache page raises the same pending signal as the chart input;
    no network call runs inside a database/numerical transaction. Unsupported
    source frames stay explicit module gaps, never substituted periods.
    """
    from sqlalchemy import func, select

    from .provider_cache import budget_transaction, ensure, read
    from .provider_capabilities import frames
    from .provider_chart import FRAME_MS
    from .storage import ProviderBar, ProviderDataset

    required_frames = [frame for frame in requests(specs, chart_frame, calendar=meta.get("calendar")) if frame in frames(meta["source"])]
    key = ensure(meta, chart_frame)
    with budget_transaction() as db:
        dataset = db.get(ProviderDataset, key)
        if origin is None:
            origin = db.scalar(select(func.min(ProviderBar.start)).where(ProviderBar.dataset_id == key))
        saved = dataset.metadata_json.get("paio_dependency_frames", [])
        requested = sorted(set(saved) | set(required_frames))
        if saved != requested:
            dataset.metadata_json = {**dataset.metadata_json, "paio_dependency_frames": requested}
    for frame in required_frames:
        span = before - origin if origin is not None else count * FRAME_MS[chart_frame]
        required = max(2, (span + FRAME_MS[frame]-1) // FRAME_MS[frame] + 1)
        check_capacity(range(required))
        # Public reads have a finite 20k page limit. Separate pages retain the
        # existing native worker's single-page lease/continuation semantics.
        cursor, remaining = before, required
        while remaining:
            page = read(meta, frame, cursor, min(20000, remaining), latest=latest and cursor == before)
            bars = page["bars"]
            if not bars or page.get("history_boundary"):
                break
            remaining -= min(20000, remaining)
            cursor = bars[0]["start"]


def capture_provider_requests(db, dataset, tail):
    """Small immutable tails + epochs, shared by price and study credentials."""
    from sqlalchemy import select

    from .provider_cache import identity
    from .storage import ProviderBar, ProviderDataset, now_ms

    result = {}
    for frame in dataset.metadata_json.get("paio_dependency_frames", []):
        dependency = db.get(ProviderDataset, identity(dataset.metadata_json, frame))
        bar = db.scalar(select(ProviderBar.payload).where(ProviderBar.dataset_id == dependency.id,
            ProviderBar.start < tail["end"]).order_by(ProviderBar.start.desc()).limit(1)) if dependency else None
        if bar:
            epoch = dependency.metadata_json.get("indicator_history_epoch") or ["legacy", dependency.revision]
            result[frame] = dict(dataset=dependency.id, epoch=epoch, revision=dependency.revision, tail=bar)
    return dict(paio_requests=result, paio_as_of=now_ms()) if result else {}
