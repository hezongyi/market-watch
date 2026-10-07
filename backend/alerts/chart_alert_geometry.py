"""Map public drawing timestamps to observed bars and explicit future calendar slots."""

from decimal import Decimal
from typing import Literal

from pydantic import Field
from sqlalchemy import select

from .chart_alert_domain import Contract, Line
from .chart_data import FRAMES, chart_rows
from .chart_geometry_mapping import bar_indices
from .chart_labels import managed_label
from .storage import Instrument, ProviderBar, ProviderDataset, now_ms


class Point(Contract):
    time: int = Field(ge=0)
    price: Decimal = Field(gt=0, allow_inf_nan=False)


class GeometryQuery(Contract):
    instrument: str = Field(min_length=1, max_length=64)
    source: str = Field(min_length=1, max_length=32)
    series_kind: Literal["managed", "provider", "composite"]
    timeframe: str
    kind: Literal["horizontal_line", "horizontal_ray", "trend_line", "ray"]
    scale: Literal["linear", "log"] = "linear"
    points: list[Point] = Field(min_length=1, max_length=2)
    extend_left: bool = False
    extend_right: bool = False
    published: bool = False
    composite_revision_id: str | None = Field(default=None, max_length=36)


def geometry(db, query, *, dataset_id=None, now=None):
    now = now_ms() if now is None else now
    expected = 1 if query.kind in ("horizontal_line", "horizontal_ray") else 2
    if len(query.points) != expected:
        raise ValueError("画线端点数量不匹配")
    if query.timeframe not in FRAMES:
        raise ValueError("未知判定周期")
    if query.series_kind == "composite":
        from .composite_alerts import geometry_rows

        rows, meta = geometry_rows(db, query.instrument, query.timeframe, query.points,
                                   revision_id=query.composite_revision_id, now=now)
        labels = [row.get("chart_time", row["start"]) for row in rows]
    elif query.series_kind == "provider":
        dataset = db.get(ProviderDataset, dataset_id)
        if not dataset or dataset.source != query.source or dataset.metadata_json["id"] != query.instrument:
            raise ValueError("画线行情身份不匹配")
        meta = dataset.metadata_json
        records = list(db.execute(select(ProviderBar.chart_time, ProviderBar.payload).where(
            ProviderBar.dataset_id == dataset_id).order_by(ProviderBar.start)))
        rows = [{**record.payload, "chart_time": record.chart_time} for record in records]
        labels = [r.chart_time for r in records]
    else:
        instrument = db.get(Instrument, query.instrument)
        if not instrument or instrument.source != query.source:
            raise ValueError("画线行情身份不匹配")
        meta = {"calendar": instrument.calendar, "calendar_profile": instrument.calendar_profile}
        if query.published:
            from .managed_dataset import read_rows
            rows = read_rows(db, instrument, query.timeframe, now + 1, 100_000)
        else:
            rows = chart_rows(db, instrument, query.timeframe, now + 1, 100_000, now)
        labels = [managed_label(row, query.timeframe, query.instrument) for row in rows]
    if query.kind == "horizontal_line":
        indices = [0]
    else:
        if not labels or meta["calendar"] not in ("ny17", "utc0"):
            raise ValueError("尚无经过核对的实际 K 线及未来交易日历")
        known = bar_indices(rows, instrument=query.instrument, timeframe=query.timeframe,
                            series_kind=query.series_kind, meta=meta,
                            future=any(p.time > labels[-1] for p in query.points))
        if any(p.time not in known for p in query.points):
            raise ValueError("画线端点未匹配实际 K 线或已验证的 500 根未来日历范围")
        indices = [known[p.time] for p in query.points]
        anchor = indices[0]
        indices = [index - anchor for index in indices]
    return Line(kind=query.kind, scale=query.scale, extend_left=query.extend_left,
                extend_right=query.extend_right,
                points=[{"time": point.time, "index": index, "price": point.price}
                        for point, index in zip(query.points, indices)]).model_dump(mode="json")
