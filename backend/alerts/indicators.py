"""Versioned, bounded-window Python indicator plugins using completed closes only.

Plugins return a value and reference in the same units. A fresh crossing produces
the signal; the caller owns timestamps, persistence, one-shot behavior and delivery.
"""

from dataclasses import dataclass
from typing import Protocol

import numpy as np
import talib


@dataclass(frozen=True)
class Reading:
    value: float
    reference: float


class Indicator(Protocol):
    def validate(self, params: dict) -> dict: ...
    def lookback(self, params: dict) -> int: ...
    def calculate(self, closes: list[str], params: dict) -> Reading: ...


class SmaCross:
    def validate(self, params):
        if set(params) - {"fast", "slow"}:
            raise ValueError("Unknown SMA parameter")
        values = {"fast": params.get("fast", 10), "slow": params.get("slow", 20)}
        if any(type(v) is not int for v in values.values()):
            raise ValueError("SMA periods must be integers")
        if not 2 <= values["fast"] < values["slow"] <= 500:
            raise ValueError("SMA requires 2 <= fast < slow <= 500")
        return values

    def lookback(self, params):
        return params["slow"]

    def calculate(self, closes, params):
        values = np.asarray(closes, dtype=np.float64)
        return Reading(
            float(talib.SMA(values, timeperiod=params["fast"])[-1]),
            float(talib.SMA(values, timeperiod=params["slow"])[-1]),
        )


# A semantic change requires a new version. Keep old entries for existing watches.
REGISTRY: dict[tuple[str, str], Indicator] = {("sma_cross", "1"): SmaCross()}


def get_indicator(name: str, version: str) -> Indicator:
    try:
        return REGISTRY[name, version]
    except KeyError:
        raise ValueError("Unknown indicator or unsupported indicator version") from None
