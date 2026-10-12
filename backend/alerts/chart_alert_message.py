"""Shared log/notification wording; indicator values retain their own units."""

from string import Formatter

from .market_names import display_code
from .storage import instant

PLACEHOLDERS = {"symbol", "source", "timeframe", "condition", "value", "threshold",
                "price", "event_time", "delay"}
RELATIONS = {"cross": "穿过", "cross_up": "上穿", "cross_down": "下穿", "above": "高于",
             "below": "低于", "enter": "进入区间", "exit": "离开区间",
             "break_upper": "上破上沿", "break_lower": "下破下沿"}


def validate_template(template):
    try:
        fields = list(Formatter().parse(template))
    except ValueError as exc:
        raise ValueError("消息占位符括号不匹配") from exc
    for _, field, format_spec, conversion in fields:
        if field is not None and (field not in PLACEHOLDERS or format_spec or conversion):
            raise ValueError("消息仅允许已列出的占位符，不支持格式表达式")


def operand_label(operand):
    if operand["kind"] == "price":
        return "价格"
    if operand["kind"] == "constant":
        return str(operand["value"])
    if operand["kind"] == "line":
        return {"horizontal_line": "水平线", "horizontal_ray": "水平射线",
                "trend_line": "趋势线", "ray": "射线"}[operand["line"]["kind"]]
    spec = operand["indicator"]
    return spec["name"] + "(" + ",".join(str(v) for v in spec["params"].values()) + ")." + spec["output"]


def condition_label(condition):
    label = operand_label(condition["left"]) + " " + RELATIONS[condition["relation"]]
    if condition.get("right"):
        label += " " + operand_label(condition["right"])
        offset = condition.get("offset")
        if offset:
            sign = "+" if condition["relation"] in ("cross_up", "above") else "−"
            label += f" {sign} {offset['multiplier']} × {offset['timeframe']} ATR({offset['period']})（取判定柱开盘前已收盘值）"
        return label
    return label + f" [{condition['lower']}, {condition['upper']}]"


def signal_title(signal):
    if not signal.evidence.get("chart_alert"):
        return f"{signal.instrument_id} · {signal.reason}"
    identity = signal.evidence.get("market_identity", {})
    symbol = display_code(identity.get("symbol") or signal.instrument_id, identity.get("source"))
    return f"{symbol} · {signal.reason}"


def signal_message(signal):
    evidence = signal.evidence
    if not evidence.get("chart_alert"):
        return f"价格 {signal.price} / 阈值 {signal.threshold}\n发生时间 {instant(signal.occurred_at).isoformat()}\n信号 {signal.id}\n请使用“确认”停止后续提醒。"
    config, identity = evidence["config"], evidence["market_identity"]
    delay = max(0, evidence["detected_at"] - signal.occurred_at) / 1000
    values = {"symbol": display_code(identity.get("symbol") or signal.instrument_id, identity.get("source")),
              "source": identity["source"],
              "timeframe": config["timeframe"], "condition": condition_label(config["condition"]),
              "value": evidence["left"], "threshold": evidence.get("threshold", str(signal.threshold)),
              "price": evidence.get("price", str(signal.price)), "event_time": instant(signal.occurred_at).isoformat(),
              "delay": f"{delay:g}s"}
    custom = config.get("message", "")
    unit_label = "价格" if evidence["unit"] == "price" else "指标值"
    message = custom.format_map(values) + "\n" if custom else ""
    offset = evidence.get("observation", {}).get("offset")
    detail = (f"\n原目标 {offset['base_target']} / ATR {offset['atr']} / 偏移 {offset['signed_offset']}"
              if offset else "")
    return (message + f"{values['symbol']} · {values['source']} · {values['timeframe']}\n"
            f"{values['condition']}\n{unit_label} {values['value']} / 比较值 {values['threshold']}\n"
            f"市场价格 {values['price']}" + detail + f"\n发生时间 {values['event_time']} / 检测延迟 {values['delay']}"
            + ("（迟到事件）" if evidence["late"] else "")
            + f"\n信号 {signal.id}\n请使用“确认”停止此事件的后续提醒。")
