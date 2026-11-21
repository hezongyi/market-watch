"""PAIO state machine, adapted from © fengyangsi's Pine v6, MPL-2.0.

This file and paio_spec.py/paio_inputs.py are covered by MPL-2.0.
The unchanged source and compatibility notes are in docs/references.
No I/O: callers freeze market/calendar/request observations before advancing.
"""

import copy
import math

from .paio_spec import ALGORITHM, METADATA, NAME, OUTPUTS, PARAMS  # noqa: F401


def source_value(source, prices, current_open=None):
    source = {"hl/2": "hl2", "ohlc/4": "ohlc4", "hlcc/4": "hlcc4"}.get(source, source)
    fields = {"hl2": ("high", "low"), "hlc3": ("high", "low", "close"),
              "ohlc4": ("open", "high", "low", "close"), "hlcc4": ("high", "low", "close", "close")}
    if source == "CurrentOpen":
        return current_open
    values = [prices.get(key) for key in fields.get(source, (source,))]
    return sum(values) / len(values) if all(value is not None for value in values) else None


class PaioState:
    def __init__(self, params=None, state=None, *, copy_state=True):
        self.params = PARAMS | (params or {})
        self.state = copy.deepcopy(state) if state and copy_state else state if state is not None else {}

    @property
    def last_presentation(self):
        return self._preview if hasattr(self, "_preview") else self.presentation()

    def create(self, kind, module, row, **geometry):
        s = self.state
        sequence = s.get("sequence", 0) + 1
        s["sequence"] = sequence
        key = f"{kind}:{sequence}"
        ledger = s.setdefault("objects", {}).setdefault(kind, {})
        ledger[key] = dict(id=key, kind=kind, module=module, sequence=sequence,
                           detected_at=row["start"], **geometry)
        if len(ledger) > 500:
            del ledger[next(iter(ledger))]
        return key

    def label(self, module, row, text, *, anchor=None, price=None, location="abovebar", color="ioLableColor", size="ioLableSize"):
        anchor_bar = next((bar for bar in self.state.get("previous", []) if bar["time"] == anchor), row)
        return self.create("label", module, row, time=row.get("chart_time", row["start"]) if anchor is None else anchor,
                           index=self.state["index"] if anchor is None else self.state["index"] - 1,
                           price=price, bar_high=float(anchor_bar["high"]), bar_low=float(anchor_bar["low"]),
                           location=location, text=text, color=color, size=size)

    def object(self, key):
        return self.state.get("objects", {}).get("label", {}).get(key)

    def presentation(self):
        s = self.state
        return dict(schema="paio_presentation_v1", render_profile="paio_v1", algorithm=ALGORITHM,
                    as_of_bar_time=s.get("last_start"), as_of=s.get("as_of"),
                    last_bar_time=s.get("last_bar_time"), origin=s.get("origin"),
                    dependency_revision=s.get("dependency_revision"), provisional=s.get("provisional", False),
                    dependencies=copy.deepcopy(s.get("dependencies", {})),
                    readiness=copy.deepcopy(s.get("readiness", {})),
                    readiness_reasons=copy.deepcopy(s.get("readiness_reasons", {})),
                    objects=[copy.deepcopy(obj) for ledger in s.get("objects", {}).values() for obj in ledger.values()])

    def step(self, row, *, provisional=False):
        if row.get("paio_terminal_partial"):
            # Keep the last confirmed checkpoint/drawings while refusing the
            # truncated fixed bucket. Genuine interior gaps still reset below.
            if hasattr(self, "_preview"):
                del self._preview
            return dict.fromkeys(OUTPUTS)
        if provisional:
            trial = PaioState(self.params, self.state)
            values = trial.step({**row, "complete": True, "paio_preview": True})
            self._preview = trial.presentation()
            return values
        if hasattr(self, "_preview"):
            del self._preview
        if row.get("gap_before") or not row["complete"]:
            self.state.clear()
        if not row["complete"]:
            return dict.fromkeys(OUTPUTS)
        prices = {key: float(row[key]) for key in ("open", "high", "low", "close")}
        if not all(math.isfinite(value) for value in prices.values()):
            raise ValueError(f"{NAME}: OHLC 必须为有限数值")
        s, p = self.state, self.params
        context = row.get("paio_context", {})
        continued = bool(s)
        s.setdefault("origin", row["start"])
        s["seam"] = bool(s.get("seam") or row.get("seam_crossing") or continued and row.get("seam_at_start"))
        s["index"] = s.get("index", -1) + 1
        s.update(as_of=context.get("as_of", row["end"]), last_bar_time=context.get("last_bar_time", row["start"]),
                 dependency_revision=context.get("revision"), provisional=bool(row.get("paio_preview")))
        if "requests" in context:
            s["requests"] = context["requests"]
        s["dependencies"] = context.get("dependencies", {})
        previous = s.get("previous", [])
        one = previous[-1] if previous else None
        two = previous[-2] if len(previous) > 1 else None
        high, low = prices["high"], prices["low"]
        out = dict.fromkeys(OUTPUTS)
        stamp = row.get("chart_time", row["start"])
        from .paio_inputs import PaioCalendarUnavailable, boundaries

        cached_bounds = {}
        def bounds(tf):
            token = {"D": "1D", "W": "1W", "M": "1M"}.get(tf, tf)
            if token not in cached_bounds:
                cached_bounds[token] = context.get("boundaries", {}).get(tf) or boundaries(row, token)
            return cached_bounds[token]

        def box(module, side, prior, top, bottom):
            self.create("box", module, row, left=prior["time"], right=stamp, top=top, bottom=bottom,
                        color=f"gs_{module}_{'u' if side == 'up' else 'd'}_color")

        for module, prior in (("open", one), ("wick", two), ("body", two)):
            if prior is None:
                continue
            a_high, a_low = (max(prior["open"], prior["close"]), min(prior["open"], prior["close"])) if module == "body" else (prior["high"], prior["low"])
            b_high, b_low = (max(prices["open"], prices["close"]), min(prices["open"], prices["close"])) if module == "body" else (high, low)
            up, down = b_low > a_high, b_high < a_low
            out[f"gap_{module}_up"], out[f"gap_{module}_down"] = int(up), int(down)
            for side, condition in (("up", up), ("down", down)):
                draw = p[f"gs_{module}_use"] and condition
                if module == "wick":
                    draw &= not p["gs_wick_except_open"] or not out[f"gap_open_{side}"] and not one[f"gap_open_{side}"]
                elif module == "body" and side == "up":
                    draw &= not p["gs_body_except_open"] or not out["gap_open_up"] and not one["gap_open_up"]
                    draw &= not p["gs_body_except_wick"] or not out["gap_wick_up"]
                elif module == "body":
                    # Deliberately asymmetric: exact source line 60.
                    draw &= not p["gs_body_except_open"] or not out["gap_wick_down"] and not out["gap_open_down"]
                    draw &= not p["gs_body_except_wick"] or not one["gap_open_down"]
                if draw:
                    box(module, side, prior, a_high if up else a_low, b_low if up else b_high)
        readiness, reasons = dict(gap=two is not None, bar_index=True), {}
        try:
            bi_bucket = bounds(p["bi_timeframe"])[0]
        except PaioCalendarUnavailable as error:
            readiness["bar_index"] = False
            reasons["bar_index"] = error.reason
        else:
            number = s.get("bi_index", 0) + 1
            if "bi_bucket" in s and s["bi_bucket"] != bi_bucket:
                number = 1
            s.update(bi_bucket=bi_bucket, bi_index=number)
            relative = number - p["bi_from"]
            specific = str(relative) in p["bi_specific"].split(",")
            out.update(bar_number=number, specific_bar=int(specific))
            if (p["bi_use"] and relative > 0 and relative <= p["bc_length"] and
                    (relative - p["bi_offset"]) % (p["bi_step"] + 1) == 0) or specific:
                self.label("bar_index", row, str(relative), location="belowbar", color="bi_color", size="bi_size")
        for index in (1, 2, 3):
            prefix = f"ma_{index}_"
            req = context.get("ema", {}).get(str(index))
            # Equal-timeframe requests can always use the exact chart prefix.
            if p[prefix + "timeframe"] in ("Chart", "", context.get("chart_tf")):
                value = source_value(p[prefix + "source"], prices)
                previous_ema = s.get(prefix + "request")
                req = value if previous_ema is None else previous_ema + (value - previous_ema) * 2 / (p[prefix + "length"] + 1)
                s[prefix + "request"] = req
            if req is not None:
                s[prefix + "last"] = req
                value = req
            else:
                last = s.get(prefix + "last")
                value = None if last is None else last + (source_value(p[prefix + "source"], prices) - last) * 2 / (p[prefix + "length"] + 1)
            out[f"ema_{index}"] = value
            readiness[f"ema_{index}"] = value is not None
        for index, ordinal in enumerate(("1st", "2nd", "3rd"), 1):
            prefix = "pv" + ordinal
            key = f"pv_{index}"
            try:
                left, right, next_end = bounds(p[prefix + "TF"])
            except PaioCalendarUnavailable as error:
                readiness[key] = False
                reasons[key] = error.reason
                continue
            pv = s.setdefault(prefix, {})
            changed = "bucket" in pv and pv["bucket"] != left
            if changed:
                pv["last"] = {"open": pv.get("open"), "high": pv.get("high"), "low": pv.get("low"), "close": one["close"] if one else None}
                pv.update(open=prices["open"], high=None, low=None)
            pv.update(bucket=left, high=max(high, pv["high"]) if pv.get("high") is not None else high,
                      low=min(low, pv["low"]) if pv.get("low") is not None else low)
            raw = source_value(p[prefix + "Source"], pv.get("last", {}), pv.get("open")) if p["pvBaseChart"] else context.get("pv", {}).get(str(index))
            filter_end = right
            try:
                if p["pvDisplay"] == "Today":
                    filter_end = bounds("D")[1]
                if p["pvDisplay"] != "All" and filter_end is None:
                    raise PaioCalendarUnavailable(p[prefix + "TF"], "NATIVE_CLOSE_UNVERIFIED")
            except PaioCalendarUnavailable as error:
                readiness[key] = False
                reasons[key] = error.reason
                pv.update(raw=raw, plot=None)
                continue
            allowed = p["pvDisplay"] == "All" or s["last_bar_time"] <= filter_end
            if p["pvLineDraw"] and p[prefix + "Use"] and next_end is None:
                readiness[key + "_line"] = False
                reasons[key + "_line"] = "NEXT_NATIVE_CLOSE_UNVERIFIED"
            if p["pvLineDraw"] and p[prefix + "Use"] and changed and allowed:
                # Retain even na-coordinate objects in the shared quota.
                from .paio_inputs import chart_coordinate

                if next_end is not None:
                    self.create("line", prefix, row, left=stamp, right=chart_coordinate(next_end, row), price=raw,
                                color=prefix + "Color", style=prefix + "Line", width=p[prefix + "Width"],
                                display_end=filter_end)
            old = pv.get("plot")
            plot = None if old is not None and raw is not None and old != raw or not allowed else raw
            pv.update(raw=raw, plot=plot)
            out[f"pv_{index}"] = plot
            readiness[key] = raw is not None
        ii = oo = ioi = False
        if two:
            inside = high <= one["high"] and low >= one["low"]
            outside = high >= one["high"] and low <= one["low"]
            changed = high != one["high"] or low != one["low"]
            ii = inside and one["high"] <= two["high"] and one["low"] >= two["low"] and changed
            oo = outside and one["high"] >= two["high"] and one["low"] <= two["low"] and changed
            ioi = inside and one["high"] >= two["high"] and one["low"] <= two["low"]
            out.update(pattern_ii=int(ii), pattern_oo=int(oo), pattern_ioi=int(ioi))
        old_oo, old_ii = s.get("oo_run", 0), s.get("ii_run", 0)
        s.update(oo_run=old_oo + 1 if oo else 0, ii_run=old_ii + 1 if ii else 0)
        def matches(key, offset):
            obj = self.object(s.get(key))
            return obj if obj and obj["index"] + offset == s["index"] else None
        if oo and p["useOO"]:
            obj = matches("last_oo", old_oo)
            if obj:
                obj["text"] = "o" * (old_oo + 2)
            else:
                s["last_oo"] = self.label("io", row, "oo")
        if ii and p["useII"]:
            obj = matches("last_ii", old_ii)
            iobj = matches("last_ioi", 2 + old_ii)
            if obj:
                obj["text"] = "i" * (old_ii + 2)
            elif iobj:
                iobj["text"] = "ioi" + "i" * (old_ii + 1)
            elif not ioi:
                s["last_ii"] = self.label("io", row, "ii")
        if ioi and p["useIOI"]:
            s["last_ioi"] = self.label("io", row, "ioi", anchor=one["time"])
            obj = matches("last_oo", old_oo)
            if obj:
                del s["objects"]["label"][obj["id"]]
                self.object(s["last_ioi"])["text"] = "i" * old_oo + "ioi"
        readiness["io"] = two is not None
        ranges = s.setdefault("ranges", [])
        ranges.append(high - low)
        s["range_sum"] = s.get("range_sum", 0.0) + high - low
        if len(ranges) > 100:
            s["range_sum"] -= ranges.pop(0)
        distance = s["range_sum"] / 100 * p["HLCInterval"] if len(ranges) == 100 else None
        if one:
            if low < one["low"]:
                s.update(bull_pb=True, bull_low=min(low, s["bull_low"]) if s.get("bull_low") is not None else low)
            if high > one["high"] and s.get("bull_pb") and p["useHLC"]:
                count = s.get("h_count", 0) + 1
                if s.get("h_last_low") is None or s["bull_low"] > s["h_last_low"]:
                    count = 1
                s.update(h_count=count, h_last_low=s["bull_low"], bull_low=None, bull_pb=False)
                self.label("hlc", row, "H" + str(count), price=high + distance if distance is not None else None,
                           location="price", color="HColor", size="normal")
            if high > one["high"]:
                s.update(bear_pb=True, bear_high=max(high, s["bear_high"]) if s.get("bear_high") is not None else high)
            if low < one["low"] and s.get("bear_pb") and p["useHLC"]:
                count = s.get("l_count", 0) + 1
                if s.get("l_last_high") is None or s["bear_high"] < s["l_last_high"]:
                    count = 1
                s.update(l_count=count, l_last_high=s["bear_high"], bear_high=None, bear_pb=False)
                self.label("hlc", row, "L" + str(count), price=low - distance if distance is not None else None,
                           location="price", color="LColor", size="normal")
        out.update(h_count=s.get("h_count", 0), l_count=s.get("l_count", 0))
        readiness["hlc"] = distance is not None
        previous.append(dict(prices, time=stamp, gap_open_up=out["gap_open_up"], gap_open_down=out["gap_open_down"]))
        s.update(previous=previous[-2:], last_start=row["start"], last_end=row["end"], readiness=readiness,
                 readiness_reasons=reasons)
        return out


def calculate(rows, params, *, provisional=False):
    engine = PaioState(params)
    values = {key: [] for key in OUTPUTS}
    for index, row in enumerate(rows):
        preview = provisional and index == len(rows) - 1 and not row["complete"]
        output = engine.step(row, provisional=preview)
        for key in OUTPUTS:
            values[key].append(output[key])
    return dict(name=NAME, version="1", params=engine.params, pane="main", levels=[],
                series=[dict(key=key, type="line", values=[dict(time=row["start"], value=value,
                    **({"provisional": True} if provisional and index == len(rows)-1 and not row["complete"] else {}),
                    **({"break_before": True} if row.get("gap_before") else {}))
                    for index, (row, value) in enumerate(zip(rows, column))]) for key, column in values.items()],
                presentation=engine.last_presentation if rows else engine.presentation())
