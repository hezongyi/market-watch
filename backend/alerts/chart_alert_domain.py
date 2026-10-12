"""Versioned chart alert contracts and a pure observation transition.

The caller supplies actual observations in order. OHLC extremes are never used
to invent an intrabar path, and line positions use bar indices, not elapsed time.
"""

from dataclasses import dataclass, replace
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .chart_indicators import CATALOG, validate


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)


class Indicator(Contract):
    name: Literal["SMA", "EMA", "RSI", "MACD"]
    version: Literal["1"] = "1"
    params: dict = Field(default_factory=dict)
    output: str = "value"

    @model_validator(mode="after")
    def canonical(self):
        name, params = validate(self.model_dump())
        if self.output not in {s["key"] for s in CATALOG[name]["series"]}:
            raise ValueError("未知指标输出")
        object.__setattr__(self, "params", params)
        return self

    @property
    def unit(self):
        return "rsi" if self.name == "RSI" else "price_delta" if self.name == "MACD" else "price"


class LinePoint(Contract):
    time: int = Field(ge=0)
    index: int
    price: Decimal = Field(gt=0, allow_inf_nan=False)


class Line(Contract):
    kind: Literal["horizontal_line", "horizontal_ray", "trend_line", "ray"]
    points: list[LinePoint] = Field(min_length=1, max_length=2)
    scale: Literal["linear", "log"] = "linear"
    extend_left: bool = False
    extend_right: bool = False
    mapping_version: Literal["bar-index-v1"] = "bar-index-v1"

    @model_validator(mode="after")
    def geometry(self):
        horizontal = self.kind in ("horizontal_line", "horizontal_ray")
        if len(self.points) != (1 if horizontal else 2):
            raise ValueError("画线端点数量不匹配")
        if not horizontal and self.points[0].index == self.points[1].index:
            raise ValueError("斜线端点不能位于同一根 K 线")
        return self


def line_value(line: Line, index: int) -> Decimal | None:
    first = line.points[0]
    if line.kind == "horizontal_line":
        return first.price
    if line.kind == "horizontal_ray":
        return first.price if index >= first.index else None
    second = line.points[1]
    lower, upper = sorted((first.index, second.index))
    left = line.extend_left or (line.kind == "ray" and second.index < first.index)
    right = line.extend_right or (line.kind == "ray" and second.index > first.index)
    if (index < lower and not left) or (index > upper and not right):
        return None
    ratio = Decimal(index - first.index) / Decimal(second.index - first.index)
    if line.scale == "log":
        return (first.price.ln() + ratio * (second.price.ln() - first.price.ln())).exp()
    return first.price + ratio * (second.price - first.price)


class Operand(Contract):
    kind: Literal["price", "constant", "indicator", "line"]
    value: Decimal | None = Field(default=None, allow_inf_nan=False)
    indicator: Indicator | None = None
    line: Line | None = None

    @model_validator(mode="after")
    def shape(self):
        fields = {"constant": "value", "indicator": "indicator", "line": "line"}
        for field in ("value", "indicator", "line"):
            if (getattr(self, field) is not None) != (fields.get(self.kind) == field):
                raise ValueError("条件对象与参数不匹配")
        return self

    @property
    def unit(self):
        return self.indicator.unit if self.indicator else "constant" if self.kind == "constant" else "price"


class AtrOffset(Contract):
    kind: Literal["atr"] = "atr"
    version: Literal["1"] = "1"
    timeframe: str
    period: int = Field(default=14, strict=True, ge=2, le=500)
    multiplier: Decimal = Field(default=Decimal("0.2"), gt=0, le=100, allow_inf_nan=False)
    reference: Literal["closed_at_evaluation_bar_open"] = "closed_at_evaluation_bar_open"

    @model_validator(mode="after")
    def frame(self):
        from .chart_data import FRAMES

        if self.timeframe not in FRAMES:
            raise ValueError("未知 ATR K线周期")
        return self

    def spec(self):
        return {"name": "ATR", "version": "1", "params": {"period": self.period}}


class Condition(Contract):
    relation: Literal["cross", "cross_up", "cross_down", "above", "below",
                      "enter", "exit", "break_upper", "break_lower"]
    left: Operand = Field(default_factory=lambda: Operand(kind="price"))
    right: Operand | None = None
    lower: Decimal | None = Field(default=None, gt=0, allow_inf_nan=False)
    upper: Decimal | None = Field(default=None, gt=0, allow_inf_nan=False)
    offset: AtrOffset | None = None

    @model_validator(mode="after")
    def compatible(self):
        interval = self.relation in ("enter", "exit", "break_upper", "break_lower")
        if self.left.kind not in ("price", "indicator"):
            raise ValueError("左侧必须为价格或受支持的指标")
        if interval:
            if self.left.kind != "price" or self.right or self.lower is None or self.upper is None:
                raise ValueError("价格区间需要上下限")
            if self.lower >= self.upper:
                raise ValueError("区间下限必须小于上限")
        elif not self.right or self.lower is not None or self.upper is not None:
            raise ValueError("比较条件需要一个比较目标")
        elif self.right.unit != "constant" and self.left.unit != self.right.unit:
            raise ValueError("条件两侧的单位不兼容")
        if self.offset and (self.relation not in ("cross_up", "cross_down", "above", "below")
                            or self.left.unit != "price" or not self.right
                            or self.right.kind not in ("constant", "line", "indicator")
                            or self.right.unit not in ("price", "constant")):
            raise ValueError("ATR 阈值仅支持价格单位的上穿、下穿、高于或低于比较")
        return self


@dataclass(frozen=True)
class Observation:
    identity: str
    sequence: int
    occurred_at: int
    left: Decimal
    right: Decimal | None = None
    market_price: Decimal | None = None
    evidence: dict | None = None

    def __post_init__(self):
        if not self.identity or self.sequence < 0 or self.occurred_at < 0:
            raise ValueError("无效观察身份")
        if not all(v.is_finite() for v in (self.left, self.right, self.market_price) if v is not None):
            raise ValueError("观察值必须有限")


@dataclass(frozen=True)
class EvaluationState:
    sequence: int | None = None
    left: str | None = None
    right: str | None = None
    count: int = 0


@dataclass(frozen=True)
class Trigger:
    observation: Observation
    direction: str
    ordinal: int
    threshold: Decimal


def advance(condition: Condition, state: EvaluationState, observation: Observation,
            max_triggers: int) -> tuple[EvaluationState, Trigger | None]:
    """First valid observation is the baseline; repeated delivery is a no-op."""
    if max_triggers not in (1, 2, 3):
        raise ValueError("触发上限只能为 1、2 或 3")
    if state.sequence is not None and observation.sequence <= state.sequence:
        return state, None
    if state.count >= max_triggers:
        return state, None
    interval = condition.relation in ("enter", "exit", "break_upper", "break_lower")
    if not interval and observation.right is None:
        raise ValueError("比较条件缺少同时刻的右侧观察值")
    next_state = replace(state, sequence=observation.sequence, left=str(observation.left),
                         right=str(observation.right) if observation.right is not None else None)
    if state.left is None:
        return next_state, None
    previous, current = Decimal(state.left), observation.left
    direction, threshold = None, observation.right
    relation = condition.relation
    if interval:
        inside = condition.lower <= current <= condition.upper
        was_inside = condition.lower <= previous <= condition.upper
        if relation == "enter" and not was_inside and inside:
            direction, threshold = "enter", condition.lower if previous < condition.lower else condition.upper
        elif relation == "exit" and was_inside and not inside:
            direction, threshold = "exit", condition.upper if current > condition.upper else condition.lower
        elif relation == "break_upper" and previous <= condition.upper < current:
            direction, threshold = "up", condition.upper
        elif relation == "break_lower" and previous >= condition.lower > current:
            direction, threshold = "down", condition.lower
    else:
        if state.right is None:
            return next_state, None
        before, after = previous - Decimal(state.right), current - observation.right
        if relation in ("cross", "cross_up") and before <= 0 < after:
            direction = "up"
        elif relation in ("cross", "cross_down") and before >= 0 > after:
            direction = "down"
        elif relation == "above" and before <= 0 < after:
            direction = "up"
        elif relation == "below" and before >= 0 > after:
            direction = "down"
    if direction is None:
        return next_state, None
    next_state = replace(next_state, count=state.count + 1)
    return next_state, Trigger(observation, direction, next_state.count, threshold)
