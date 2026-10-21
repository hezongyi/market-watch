"""Safe supplier failures at HTTP boundaries; never include upstream bodies."""
import math

import httpx
from fastapi import HTTPException

from .provider_yahoo import YahooError
from .storage import Preference, now_ms, transaction


def resolve_error(error):
    with transaction() as db:
        row = db.get(Preference, "upstream_slots:yahoo")
        until = (row.value if row else {}).get("cooldown_until", 0)
    timed_out = isinstance(error, (TimeoutError, httpx.TimeoutException))
    code = error.status if isinstance(error, YahooError) else (
        "rate_limited" if timed_out and until > now_ms() else
        "timeout" if timed_out else "request_failed")
    retryable = code in {"timeout", "request_failed", "rate_limited", "metadata_unavailable"}
    messages = {
        "timeout": "行情来源响应超时，请重试",
        "request_failed": "行情来源暂不可用，请重试",
        "rate_limited": "行情来源限流，请等待冷却后重试",
        "metadata_unavailable": "品种元信息暂不可用，请重试",
        "authentication": "行情来源认证失败，请检查来源配置",
        "configuration": "行情来源配置不完整，请检查配置",
        "disabled": "行情来源未启用",
        "unsupported": "此品种暂不受行情来源支持",
    }
    headers = {}
    if code == "rate_limited":
        headers["Retry-After"] = str(max(1, math.ceil((until - now_ms()) / 1000)))
    return HTTPException(503, {"code": code, "status": code,
                              "message": messages.get(code, "行情来源暂不可用，请检查来源状态"),
                              "retryable": retryable}, headers=headers)
