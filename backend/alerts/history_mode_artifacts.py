"""Native pass-through and source-trading-date D1 reduction on fixed inputs."""

import gzip
import hashlib
import json
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal, InvalidOperation

from sqlalchemy import select

from .market_contracts import NativeBarRow
from .market_datasets import version_price_rows
from .source_history_store import raw_chunk
from .storage import HistoryArtifactBlock, HistoryChunk, now_ms

RULE = "source-trading-date-artifact-qfq-v2"
QFQ_RULE = "managed-qfq-display-v1"


class QfqUnavailable(ValueError):
    pass


def _qfq_row(row, dataset):
    identity = dataset.identity
    family = identity.get("source_family")
    equity = dataset.asset_class in ("equity", "etf")
    if not equity or family not in ("sina-a", "sina-hk", "yfinance"):
        return row
    adjustment = identity.get("adjustment")
    if adjustment != "none" and not (family == "yfinance" and adjustment == "supplier"):
        return {**row, "adjustment_view": identity.get("adjustment"),
                "adjustment_rule": "supplier-adjusted-v1"}
    basis = row.get("adjustment_basis")
    if not isinstance(basis, dict):
        raise QfqUnavailable("前复权依据缺失；原始行情已保留，请刷新来源依据后重试")
    try:
        value = Decimal(str(basis.get("value", "0")))
    except InvalidOperation:
        raise QfqUnavailable("前复权依据无效；原始行情已保留") from None
    expected = {"sina-a": "sina_qfq_factor", "sina-hk": "sina_qfq_factor",
                "yfinance": "yahoo_adj_close_ratio"}[family]
    if basis.get("kind") != expected or not value.is_finite() or value <= 0:
        raise QfqUnavailable("前复权依据无效；原始行情已保留")
    output = dict(row)
    if family == "sina-a":
        def operation(price):
            return Decimal(str(price)) / value
    else:
        def operation(price):
            return Decimal(str(price)) * value
    for field in ("open", "high", "low", "close"):
        output[field] = format(operation(row[field]), "f")
    output["adjustment_view"] = "qfq"
    output["adjustment_rule"] = QFQ_RULE
    return output


def date_bounds(day, frame):
    """UTC chart labels; these bounds do not assert a continuous exchange session."""
    day = date.fromisoformat(day) if isinstance(day, str) else day
    if frame == "D1":
        left, right = day, day + timedelta(days=1)
    elif frame == "W1":
        left = day - timedelta(days=day.weekday())
        right = left + timedelta(days=7)
    elif frame == "MN":
        left = day.replace(day=1)
        right = date(left.year + (left.month == 12), left.month % 12 + 1, 1)
    else:
        raise ValueError("D1 base supports only D1, W1 and MN")
    return tuple(int(datetime.combine(value, datetime.min.time(), UTC).timestamp() * 1000)
                 for value in (left, right))


def _add(state, row):
    if not state.get("observed_bars"):
        state.update({key: row[key] for key in ("open", "high", "low", "close")})
        state.update(volume="0", volume_present=True, observed_bars=0, source_confirmed=True,
                     trading_date=row["trading_date"])
    state["high"] = str(max(Decimal(state["high"]), Decimal(row["high"])))
    state["low"] = str(min(Decimal(state["low"]), Decimal(row["low"])))
    state["close"] = row["close"]
    state["observed_bars"] += 1
    state["source_confirmed"] &= row["complete"]
    if row["volume"] is None:
        state["volume_present"] = False
    else:
        state["volume"] = str(Decimal(state["volume"]) + Decimal(row["volume"]))


def _finish(state, version, dataset, *, next_period=False, rule_version=RULE):
    closed = next_period or state["end"] <= version.end
    complete = closed and state["source_confirmed"]
    return {key: state[key] for key in ("start", "end", "open", "high", "low", "close",
                                       "trading_date", "observed_bars", "source_confirmed")} | {
        "volume": state["volume"] if state["volume_present"] else None,
        "volume_complete": complete and state["volume_present"],
        "complete": complete, "time_closed": closed,
        "coverage_complete": True, "coverage_policy": "observed_trading_days",
        "volume_kind": dataset.volume_kind, "volume_unit": dataset.volume_unit,
        "parent_version_id": version.id, "rule_version": rule_version,
        "provenance": "d1_reducer", "input_timeframe": "D1"}


def artifact_step(db, artifact, version, dataset, instrument):
    """One source block per transaction; accumulator survives worker restarts."""
    mode = dataset.identity["mode"]
    frame = "D1" if mode == "base_d1" else artifact.timeframe
    chunk = db.scalar(select(HistoryChunk).where(HistoryChunk.version_id == version.id,
        HistoryChunk.timeframe == frame, HistoryChunk.end > artifact.cursor)
        .order_by(HistoryChunk.start).limit(1))
    state, output = dict(artifact.accumulator), []
    if chunk:
        rows = version_price_rows(json.loads(raw_chunk(db, chunk)), version.manifest)
        for value in rows:
            row = NativeBarRow.model_validate(value).model_dump()
            if artifact.rule_version == RULE:
                row = _qfq_row(row, dataset)
            if row["start"] < artifact.cursor:
                continue
            if mode == "native_periods" or artifact.timeframe == "D1":
                output.append({**row, "volume_complete": row["complete"] and row["volume"] is not None,
                    "time_closed": row["end"] <= version.end, "source_confirmed": row["complete"],
                    "coverage_complete": True, "coverage_policy": "supplier_native",
                    "volume_kind": dataset.volume_kind, "volume_unit": dataset.volume_unit,
                    "parent_version_id": version.id, "rule_version": artifact.rule_version,
                    "provenance": "native", "input_timeframe": frame})
                continue
            left, right = date_bounds(row["trading_date"], artifact.timeframe)
            if state and state["start"] != left:
                output.append(_finish(state, version, dataset, next_period=True, rule_version=artifact.rule_version))
                state = {}
            if not state:
                state = {"start": left, "end": right}
            _add(state, row)
        artifact.cursor = min(version.end, chunk.end)
    else:
        artifact.cursor = version.end
    if artifact.cursor == version.end and state:
        output.append(_finish(state, version, dataset, rule_version=artifact.rule_version))
        state = {}
    for offset in range(0, len(output), 2000):
        part = output[offset:offset + 2000]
        raw = json.dumps(part, sort_keys=True, separators=(",", ":")).encode()
        db.add(HistoryArtifactBlock(artifact_id=artifact.id, start=part[0]["start"],
            end=part[-1]["end"], count=len(part), checksum=hashlib.sha256(raw).hexdigest(),
            content=gzip.compress(raw, mtime=0)))
    artifact.count += len(output)
    artifact.complete_count += sum(row["complete"] for row in output)
    artifact.accumulator = state
    artifact.updated_at = now_ms()
    if artifact.cursor != version.end:
        return
    db.flush()
    blocks = list(db.scalars(select(HistoryArtifactBlock).where(
        HistoryArtifactBlock.artifact_id == artifact.id).order_by(HistoryArtifactBlock.start)))
    facts = version.manifest.get("frames", {}).get(frame, {})
    family, adjustment = dataset.identity.get("source_family"), dataset.identity.get("adjustment")
    qfq_view = artifact.rule_version == RULE and dataset.asset_class in ("equity", "etf") and (
        family in ("sina-a", "sina-hk") and adjustment == "none" or
        family == "yfinance" and adjustment in ("none", "supplier"))
    artifact.manifest = {"parent_version_id": version.id, "parent_checksum": version.manifest["checksum"],
            "timeframe": artifact.timeframe, "rule_version": artifact.rule_version,
        "adjustment_view": "qfq" if qfq_view else "raw",
        "adjustment_rule": QFQ_RULE if qfq_view else None, "identity": dataset.identity,
        "aggregation_calendar": instrument.calendar, "rows": artifact.count,
        "complete_rows": artifact.complete_count, "input_timeframe": frame,
        "provenance": "d1_reducer" if mode == "base_d1" and artifact.timeframe != "D1" else "native",
        "freshness": facts.get("status"), "observed_at": facts.get("observed_at"),
        "blocks": [{"id": b.id, "start": b.start, "end": b.end, "count": b.count,
                    "checksum": b.checksum} for b in blocks],
        "checksum": hashlib.sha256("".join(b.checksum for b in blocks).encode()).hexdigest()}
    artifact.status, artifact.published_at = "published", now_ms()
