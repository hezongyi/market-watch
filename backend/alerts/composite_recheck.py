"""Explicit, bounded source rechecks; queries never certify missing minutes."""
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import select

from .composite_revisions import owned
from .storage import (
    CompositePreparation,
    CompositeReadAttempt,
    CompositeRevision,
    Instrument,
    MarketDataset,
    RealtimeMapping,
    now_ms,
    transaction,
)


class RecheckRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: str = Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9:_-]+$")
    start: int = Field(ge=0, multiple_of=60000)
    end: int = Field(ge=0, multiple_of=60000)

    @model_validator(mode="after")
    def bounded(self):
        if not 0 < self.end - self.start <= 86400000:
            raise ValueError("一次来源复核须为1分钟至24小时")
        return self


def report(attempt):
    return dict(request_id=attempt.id, start=attempt.start, end=attempt.end,
                status=attempt.result, finished_at=attempt.finished_at,
                observations=attempt.observations, accepted=attempt.accepted,
                coverage="observations_only; missing minutes remain unknown")


def recheck(composite_id, revision_id, body, adapter):
    from .composite_preparation import _finish, read_id
    from .history_sources import HistoryConfigurationError
    from .market_contracts import DatasetIdentity, MarketRequestError, failed_request
    from .market_resources import lane
    from .source_history_store import shared_page

    body = RecheckRequest.model_validate(body)
    token = read_id("gap:" + revision_id + ":" + body.request_id)
    stamp = now_ms()
    from .live_window import require_window

    require_window(body.start, now=stamp)
    with transaction() as db:
        owned(db, composite_id, lock=True)
        revision = db.get(CompositeRevision, revision_id)
        prep = db.get(CompositePreparation, revision_id)
        if not revision or revision.composite_id != composite_id or not prep or prep.status != "queried":
            raise ValueError("请选择已完成接续查询的固定组合修订")
        if body.start < revision.seam or body.end > stamp // 60000 * 60000:
            raise ValueError("仅复核拼接后的已结束来源分钟")
        previous = db.get(CompositeReadAttempt, token)
        if previous:
            if (previous.start, previous.end) != (body.start, body.end):
                raise ValueError("请求编号已用于另一复核区间")
            if previous.finished_at is None and stamp - previous.started_at >= 60000:
                _finish(previous, 'timeout')
            return report(previous)
        mapping = db.get(RealtimeMapping, revision.mapping_id)
        target = db.get(MarketDataset, mapping.target_dataset_id)
        identity = DatasetIdentity.model_validate(target.identity)
        # Use this revision's accepted inputs and its target-source calendar.
        # Query completion and historical-source closures cannot prove a tail
        # minute complete. Check before reserving a scarce source-read attempt;
        # retries above still return their result after the gap has been filled.
        from .composite_inputs import rows
        from .composite_series import _closed

        observed = {row['timestamp']: row for row in rows(db, revision_id, body.start, body.end,
                                                        input_revision=prep.input_revision)}
        segment = {'profile': db.get(Instrument, target.instrument_id).calendar_profile}
        if not any(not observed[at]['complete'] if at in observed else
                   not _closed(at, segment, revision.rules['aggregation_calendar'])
                   for at in range(body.start, body.end, 60000)):
            raise ValueError("所选区间没有未知分钟，无需来源复核；请核对缺口日期")
        attempts = list(db.scalars(select(CompositeReadAttempt).where(
            CompositeReadAttempt.revision_id == revision_id,
            CompositeReadAttempt.read_kind == "gap_recheck",
            CompositeReadAttempt.started_at >= stamp - 86400000)))
        if len(attempts) >= 3 or any(stamp - item.started_at < 60000 for item in attempts):
            raise ValueError("来源复核每修订每天最多3次，间隔至少1分钟；请查看查询记录")
        db.add(CompositeReadAttempt(id=token, revision_id=revision_id, start=body.start, end=body.end,
                                   started_at=stamp, read_kind="gap_recheck"))
    batch, failure = None, None
    try:
        with lane("history"):
            batch = shared_page(adapter, identity, body.start, body.end, fresh_after=stamp - 1)
        if not batch.result.successful:
            raise MarketRequestError(batch.result)
        if batch.identity != identity or (batch.window_start, batch.window_end) != (body.start, body.end):
            raise ValueError("来源复核身份或区间不匹配")
        with transaction() as db:
            from .composite_inputs import apply_minutes
            from .confirmed_minutes import record
            # The same source -> preparation lock order as live confirmation.
            recorded = record(db, batch)
            attempt = db.get(CompositeReadAttempt, token)
            if attempt.finished_at is not None or now_ms() - attempt.started_at >= 60000:
                raise TimeoutError("来源复核结果已过期")
            apply_minutes(db, recorded, revision_id=revision_id, reason="gap_recheck")
            _finish(attempt, batch.result.status, batch=batch, accepted=True)
            return report(attempt)
    except Exception as error:
        if isinstance(error, HistoryConfigurationError):
            failure = 'configuration_error'
        else:
            failure = (error.result if isinstance(error, MarketRequestError) else failed_request(error, observed_at=now_ms())).status
    with transaction() as db:
        attempt = db.get(CompositeReadAttempt, token)
        _finish(attempt, failure, batch=batch)
        return report(attempt)
