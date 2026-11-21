"""PAIO input contract. Adapted from © fengyangsi, MPL-2.0.

See docs/references/paio-fengyangsi-v6-20261118.pine (unchanged original).
Host capacity limits are explicit; no parameter is silently clamped.
"""

NAME = "PAIO_V1"
ALGORITHM = "paio-fengyangsi-v6-state-v1"
FRAMES = {**dict(zip(("1", "5", "15", "30", "60", "240", "1D", "1W", "1M"),
                     ("M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN"))),
          "D": "D1", "W": "W1", "M": "MN", "Chart": "Chart", "": "Chart"}
SOURCES = ["open", "high", "low", "close", "hl2", "hlc3", "ohlc4", "hlcc4"]
PV_SOURCES = ["close", "high", "low", "open", "hl/2", "hlc3", "ohlc/4", "hlcc/4", "CurrentOpen"]
OUTPUTS = ("gap_open_up", "gap_open_down", "gap_wick_up", "gap_wick_down",
           "gap_body_up", "gap_body_down", "specific_bar", "pattern_oo", "pattern_ii",
           "pattern_ioi", "ema_1", "ema_2", "ema_3", "pv_1", "pv_2", "pv_3",
           "bar_number", "h_count", "l_count")
ALERTS = dict(zip(OUTPUTS[:10], (
    ("PAIO:GS:Gap Up(Open)", "Bullish Opening Gap!"),
    ("PAIO:GS:Gap Down(Open)", "Bearish Opening Gap!"),
    ("PAIO:GS:Gap Up(Wick)", "Bullish Wick Gap!"),
    ("PAIO:GS:Gap Down(Wick)", "Bearish Wick Gap!"),
    ("PAIO:GS:Gap Up(Body)", "Bullish Body Gap!"),
    ("PAIO:GS:Gap Down(Body)", "Bearish Body Gap!"),
    ("PAIO:BI:Specific Bar Reached", "Specific Bar Reached"),
    ("OO Pattern", "OO Pattern"), ("II Pattern", "II Pattern"), ("IOI Pattern", "IOI Pattern"),
)))
PARAMS, SCHEMA, DISPLAY = {}, {}, []


def parameter(key, value, group, label, kind=None, **limits):
    kind = kind or ("bool" if type(value) is bool else "integer" if type(value) is int else "float")
    PARAMS[key] = value
    SCHEMA[key] = dict(type=kind, default=value, label=label, group=group, **limits)


def enum(key, value, options, group, label):
    parameter(key, value, group, label, "enum", options=options)


def style(key, value, group, label, options=None):
    DISPLAY.append(dict(id=key, name=label, group=group, type="text" if options else "color",
                        default=value, **({"options": options} if options else {})))


for module, title, opacity in (("open", "Open", .6), ("wick", "wick", .4), ("body", "Body", .2)):
    parameter(f"gs_{module}_use", True, "Gap Series", title)
    for side, rgb in (("u", "8,153,129"), ("d", "242,54,69")):
        style(f"gs_{module}_{side}_color", f"rgba({rgb},{opacity})", "Gap Series", f"{title} {'↑' if side == 'u' else '↓'}")
for key in ("gs_wick_except_open", "gs_body_except_open", "gs_body_except_wick"):
    parameter(key, True, "Gap Series", key.replace("gs_", "").replace("_", " "))
parameter("bi_use", True, "Bar Index", "Bar Index")
SIZES = ["auto", "tiny", "small", "normal", "large", "huge"]
style("bi_size", "normal", "Bar Index", "Size", SIZES)
style("bi_color", "#ff9800", "Bar Index", "Color")
enum("bi_timeframe", "1D", ["1", "5", "15", "30", "60", "240", "1D", "1W", "1M"], "Bar Index", "Timeframe")
for key, value, low, high, label in (("bi_from", 0, 0, 1000000, "From"),
                                     ("bc_length", 999, 0, 1000000, "Length"),
                                     ("bi_step", 2, 0, 1000000, "Step"),
                                     ("bi_offset", 0, -1000000, 1000000, "Offset")):
    parameter(key, value, "Bar Index", label, min=low, max=high)
parameter("bi_specific", "0,1", "Bar Index", "Specific Bars", "text", max_length=1024)
for index, frame in enumerate(("Chart", "15", "60"), 1):
    prefix = f"ma_{index}_"
    parameter(prefix + "use", True, "Moving Average", f"{index} EMA")
    parameter(prefix + "length", 20, "Moving Average", f"{index} Length", min=1, max=10000)
    parameter(prefix + "offset", 0, "Moving Average", f"{index} Offset", min=-500, max=500)
    enum(prefix + "timeframe", frame, ["Chart", "1", "5", "15", "30", "60", "240", "1D", "1W", "1M"], "Moving Average", f"{index} Timeframe")
    enum(prefix + "source", "close", SOURCES, "Moving Average", f"{index} Source")
enum("pvDisplay", "All", ["Today", "TimeFrame", "All"], "Previous Values", "Display")
parameter("pvBaseChart", True, "Previous Values", "Base On Chart")
parameter("pvLineDraw", True, "Previous Values", "Draw By Line")
for index, ordinal, source, color, line in ((1, "1st", "close", "#434651", "dotted"),
                                           (2, "2nd", "high", "#F23645", "dashed"),
                                           (3, "3rd", "low", "#089981", "dashed")):
    prefix = f"pv{ordinal}"
    parameter(prefix + "Use", True, "Previous Values", ordinal)
    enum(prefix + "TF", "1D", ["1", "5", "15", "30", "60", "240", "1D", "1W", "1M"], "Previous Values", ordinal + " Timeframe")
    enum(prefix + "Source", source, PV_SOURCES, "Previous Values", ordinal + " Source")
    style(prefix + "Color", color, "Previous Values", ordinal + " Color")
    style(prefix + "Line", line, "Previous Values", ordinal + " Line Style",
          ["solid", "dotted", "dashed", "arrow_left", "arrow_right", "arrow_both"])
    parameter(prefix + "Width", 1, "Previous Values", ordinal + " Width", min=1, max=10)
for key, label in (("useOO", "Use OO Pattern"), ("useII", "Use II Pattern"), ("useIOI", "Use IOI Pattern")):
    parameter(key, True, "I & O Bar", label)
style("ioLableSize", "large", "I & O Bar", "Label Size", SIZES)
style("ioLableColor", "#787b86", "I & O Bar", "Label Color")
parameter("useHLC", True, "H & L Count", "Use Count")
style("HColor", "#089981", "H & L Count", "H Color")
style("LColor", "#F23645", "H & L Count", "L Color")
parameter("HLCInterval", 1.0, "H & L Count", "Interval", min=-100, max=100)
METADATA = dict(
    label="PAIO 价格行为组合", aliases=["PAIO", "Price Action All In One", "价格行为", "fengyangsi"],
    description="Gap、编号、EMA、Previous Values、I/O 与 H/L 六组源码复刻。© fengyangsi，MPL 2.0。",
    calculation="固定起点状态机；保留原始条件及标签分支。多周期缺失按模块标明，不用其他来源替代。",
    pane="main", params=PARAMS, parameter_schema=SCHEMA, input_fields=["open", "high", "low", "close"],
    series=[dict(key=key, type="line", label=ALERTS[key][0] if key in ALERTS else key) for key in OUTPUTS],
    render_profile="paio_v1", result_format="paio_presentation_v1", display_inputs=DISPLAY,
    history_requirement=lambda p: 0,
)
