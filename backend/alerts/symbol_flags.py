"""Versioned account flags, independent from layouts and list membership."""

from .chart_series import decode, encode

COLORS = frozenset({"red", "blue", "green", "yellow", "purple", "cyan", "pink"})
PREFERENCE_NAME = "mw.symbol-flags.v1"


def validate_flags(content: dict) -> None:
    value = content.get("value")
    if not isinstance(value, dict) or type(value.get("version")) is not int or value["version"] != 1:
        raise ValueError("不支持的收藏偏好版本")
    flags = value.get("flags")
    if not isinstance(flags, dict) or len(flags) > 5000:
        raise ValueError("收藏品种格式无效或超过 5000 个")
    for ticker, color in flags.items():
        if not isinstance(ticker, str) or not isinstance(color, str) or color not in COLORS:
            raise ValueError("无效收藏颜色")
        if ticker.startswith("MWPY_"):
            raise ValueError("指标不是可收藏的基础品种")
        symbol, kind = decode(ticker)
        if encode(symbol, kind) != ticker:
            raise ValueError("收藏需要规范的完整品种标识")
