"""Whitelist saved drawing projections; never infer lines from prices or pixels."""

import math
from decimal import Decimal

from sqlalchemy import select

from ..chart_series import decode
from ..storage import AdvancedWorkspace, ChartWorkspace, Instrument, transaction
from .context import CapabilityError

TYPES = {
    "HorizontalLine": 1,
    "TrendLine": 2,
    "Ray": 2,
    "Rectangle": 2,
    "FibRetracement": 2,
    "Text": 1,
    "ParallelChannel": 3,
    "LongShortPosition": 3,
}
NATIVE_TYPES = {
    "horizontal_line": 1,
    "trend_line": 2,
    "ray": 2,
    "rectangle": 2,
    "fib_retracement": 2,
    "text": 1,
    "parallel_channel": 3,
    "long_position": 3,
    "short_position": 3,
}
FRAMES = {
    "1": "M1",
    "5": "M5",
    "15": "M15",
    "30": "M30",
    "60": "H1",
    "240": "H4",
    "1D": "D1",
    "D": "D1",
    "1W": "W1",
    "W": "W1",
    "1M": "MN",
}


def projection(document):
    state = document.get("state", {})
    if not isinstance(state, dict):
        return None
    # Projection also survives the historical layout envelope.
    if "charts" not in state and isinstance(state.get("content"), str):
        import json

        try:
            state = json.loads(state["content"])
        except (ValueError, TypeError):
            return None
    return state.get("_mwDrawingProjection") if isinstance(state, dict) else None


def workspaces(ctx, query):
    model = AdvancedWorkspace if query.engine == "native" else ChartWorkspace
    with transaction() as db:
        rows = db.scalars(
            select(model)
            .order_by(model.updated_at.desc(), model.id)
            .offset(query.offset)
            .limit(query.limit + 1)
        ).all()
        items = [
            {
                "id": row.id,
                "name": row.name,
                "revision": row.revision,
                "updated_at": row.updated_at,
                "engine": query.engine,
                "projection_available": query.engine == "legacy" or bool(projection(row.document)),
            }
            for row in rows[: query.limit]
        ]
    return {
        "items": items,
        "next_offset": query.offset + query.limit if len(rows) > query.limit else None,
    }


def object_projection(item, native):
    ident = item.get("id")
    tool = item.get("name" if native else "toolType", "unknown")
    result = {
        "object_id": str(ident or "unknown"),
        "object_type": str(tool),
        "supported": False,
        "anchors": [],
        "reason": "unsupported_object",
    }
    required = (NATIVE_TYPES if native else TYPES).get(tool)
    points = item.get("points", [])
    if (
        not isinstance(ident, str)
        or not required
        or not isinstance(points, list)
        or len(points) != required
    ):
        return result
    anchors = []
    for point in points:
        if not isinstance(point, dict):
            return result
        price, stamp = point.get("price"), point.get("time" if native else "timestamp")
        if type(price) not in (int, float) or not math.isfinite(price):
            return result
        # Native horizontal lines have price-only coordinates.
        if stamp is None and native and tool == "horizontal_line":
            pass
        elif type(stamp) not in (int, float) or not math.isfinite(stamp):
            return result
        anchors.append(
            {"time": None if stamp is None else stamp * 1000, "price": str(Decimal(str(price)))}
        )
    return {**result, "supported": True, "anchors": anchors, "reason": None}


def source_of(db, instrument, kind):
    if kind == "provider":
        from ..storage import MarketCatalog

        row = db.get(MarketCatalog, instrument) or db.get(Instrument, instrument)
        return row.source if row else "yahoo" if instrument.startswith("YAHOO:") else None
    row = db.get(Instrument, instrument)
    return row.source if row else None


def drawings(ctx, query):
    model = AdvancedWorkspace if query.engine == "native" else ChartWorkspace
    with transaction() as db:
        row = db.get(model, query.workspace_id)
        if not row:
            raise CapabilityError("WORKSPACE_NOT_FOUND", "Saved workspace does not exist")
        document = row.document
        if query.engine == "native":
            projected = projection(document)
            if (
                not isinstance(projected, dict)
                or projected.get("version") != 1
                or not isinstance(projected.get("charts"), list)
            ):
                raise CapabilityError(
                    "UNSUPPORTED_CAPABILITY",
                    "Native workspace lacks a verified saved projection; resave it in the updated chart client",
                )
            charts = []
            for index, chart in enumerate(projected["charts"]):
                try:
                    instrument, kind = decode(chart["symbol"])
                    objects = chart["drawings"]
                    if not isinstance(objects, list) or not isinstance(chart["resolution"], str):
                        raise ValueError()
                except (TypeError, ValueError, KeyError):
                    raise CapabilityError(
                        "INVALID_DRAWING_PROJECTION", "Saved chart identity is invalid"
                    ) from None
                charts.append(
                    {
                        "chart_id": str(chart.get("chart_id", index)),
                        "chart_index": index,
                        "time_coordinate": "native_chart_time_ms",
                        "instrument": instrument,
                        "source": source_of(db, instrument, kind),
                        "series_kind": kind,
                        "timeframe": FRAMES.get(chart["resolution"], chart["resolution"]),
                        "status": chart.get("status", "supported"),
                        "drawings": [
                            object_projection(item, True)
                            for item in objects
                            if isinstance(item, dict)
                        ],
                    }
                )
        else:
            charts = []
            for panel in document.get("panels", []):
                instrument = panel["instrument"]
                charts.append(
                    {
                        "chart_id": panel["id"],
                        "instrument": instrument,
                        "source": source_of(db, instrument, "managed"),
                        "series_kind": "managed",
                        "timeframe": panel["timeframe"],
                        "time_coordinate": "utc_ms",
                        "drawings": [
                            object_projection(item, False)
                            for item in document.get("drawings", {}).get(instrument, [])
                        ],
                    }
                )
        return {
            "workspace_id": row.id,
            "revision": row.revision,
            "saved_at": row.updated_at,
            "engine": query.engine,
            "charts": charts,
            "visibility": "saved_only",
            "projection_version": 1,
        }
