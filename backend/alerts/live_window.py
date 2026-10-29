"""UTC availability boundary for live tails; fixed history is unaffected."""

from .storage import now_ms

WINDOW_MS = 30 * 24 * 3600 * 1000


def lower_bound(now=None):
    return (now_ms() if now is None else int(now)) - WINDOW_MS


def require_window(start, *, now=None):
    if start < lower_bound(now):
        raise ValueError("实时输入已超出30天可用窗口，请更新历史基线")
