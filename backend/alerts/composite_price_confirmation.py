"""Account-bound native OHLC evidence; never fills M1 or certifies its coverage.

Evaluators enqueue/read only. The native-history worker performs bounded source
I/O outside transactions and publishes immutable blobs under a fenced lease.
"""

import gzip
import hashlib
import json
from decimal import Decimal

from sqlalchemy import select

from .market_contracts import failed_request
from .source_history_store import _insert, store_blob
from .source_registry import SourceIdentity, platform_identity
from .storage import ChartAlert, SourceBlob, SourceFetch, SourceSeries, now_ms, transaction, uid

PREFIX = "ohlc:"
CONTRACT = "account-native-ohlc-v1"
RETRY_MS = 60000


def eligible(config, revision, bar):
    """Only closed, single-target D1 price/horizontal-line dependencies qualify."""
    return (config.mode == "close" and config.timeframe == "D1"
        and config.condition.offset is None and bar["start"] >= revision.seam
        and not bar.get("seam_crossing") and not bar.get("session_conflict")
        and bar["time_closed"] and bar["source_confirmed"]
        and all(operand is None or operand.kind in ("price", "constant")
            or operand.kind == "line" and operand.line.kind == "horizontal_line"
            for operand in (config.condition.left, config.condition.right)))


def _source(identity, phase):
    if phase not in ("ny17", "utc0"):
        raise ValueError("Unsupported native confirmation alignment")
    return platform_identity(identity, timeframe="D1", daily_alignment=17 if phase == "ny17" else 0,
                             alignment_timezone="America/New_York" if phase == "ny17" else "UTC")


def _key(source, start, end):
    return PREFIX + hashlib.sha256(f"{CONTRACT}|{source.key}|{start}|{end}".encode()).hexdigest()[:59]


def _matches(evidence, source, bar):
    return (evidence.get("contract") == CONTRACT and evidence.get("source_id") == source.key
        and evidence.get("complete") is True
        and (evidence.get("start"), evidence.get("end")) == (bar["start"], bar["end"])
        and all(Decimal(evidence[field]) == Decimal(str(bar[field]))
                for field in ("open", "high", "low", "close")))


def confirmation(db, identity, phase, bar, runtime):
    """Return a price proof or enqueue an independent source check, with no I/O."""
    source = _source(identity, phase)
    key = _key(source, bar["start"], bar["end"])
    runtime["price_confirmation_request"] = key
    db.execute(_insert(db)(SourceSeries).values(id=source.key, identity=source.model_dump())
        .on_conflict_do_nothing(index_elements=["id"]))
    series = db.get(SourceSeries, source.key)
    if series.identity != source.model_dump():
        raise ValueError("Native price source identity collision")
    db.execute(_insert(db)(SourceFetch).values(id=key, source_id=source.key,
        start=bar["start"], end=bar["end"], fetched_at=0, lease_until=0)
        .on_conflict_do_nothing(index_elements=["id"]))
    fetch = db.scalar(select(SourceFetch).where(SourceFetch.id == key).with_for_update())
    if (fetch.source_id, fetch.start, fetch.end) != (source.key, bar["start"], bar["end"]):
        raise ValueError("Native price window collision")
    if fetch.content_id:
        blob = db.get(SourceBlob, fetch.content_id)
        raw = gzip.decompress(blob.content)
        if blob.source_id != source.key or hashlib.sha256(raw).hexdigest() != blob.checksum:
            raise ValueError("Native price proof checksum mismatch")
        evidence = json.loads(raw)
        if _matches(evidence, source, bar):
            return {"kind": "native_ohlc_match", **evidence,
                    "content_id": blob.id, "checksum": blob.checksum}
        # A changed M1 input must match again; cached native prices never
        # overwrite the composite. The worker retries at most once per minute.
        if fetch.result == "data":
            fetch.result = "pending"
    return None


def claim():
    with transaction() as db:
        stamp = now_ms()
        active = select(ChartAlert.runtime["price_confirmation_request"].as_string()).where(
            ChartAlert.status == "active",
            ChartAlert.expires_at.is_(None) | (ChartAlert.expires_at > stamp))
        fetch = db.scalar(select(SourceFetch).where(SourceFetch.id.startswith(PREFIX),
            SourceFetch.id.in_(active),
            SourceFetch.lease_until <= stamp, SourceFetch.fetched_at <= stamp - RETRY_MS,
            (SourceFetch.result.is_(None) | (SourceFetch.result != "data")))
            .order_by(SourceFetch.fetched_at, SourceFetch.id)
            .with_for_update(skip_locked=True).limit(1))
        if not fetch:
            return None
        source = SourceIdentity.model_validate(db.get(SourceSeries, fetch.source_id).identity)
        if source.key != fetch.source_id or _key(source, fetch.start, fetch.end) != fetch.id:
            raise ValueError("Native price task source binding mismatch")
        fetch.lease_token, fetch.lease_until = uid(), stamp + 60000
        return {"id": fetch.id, "source": source, "start": fetch.start, "end": fetch.end,
                "token": fetch.lease_token}


def commit(ownership, evidence, result):
    with transaction() as db:
        fetch = db.scalar(select(SourceFetch).where(SourceFetch.id == ownership["id"]).with_for_update())
        if fetch.lease_token != ownership["token"] or fetch.lease_until <= now_ms():
            raise TimeoutError("Native price evidence lease expired or superseded")
        if evidence is not None:
            source = ownership["source"]
            if (evidence.get("contract") != CONTRACT or evidence.get("source_id") != source.key
                    or evidence.get("complete") is not True
                    or (evidence.get("start"), evidence.get("end")) != (fetch.start, fetch.end)):
                raise ValueError("Native price evidence does not match leased window")
            raw = json.dumps(evidence, sort_keys=True, separators=(",", ":")).encode()
            fetch.content_id, _ = store_blob(db, source.key, raw)
            fetch.checkpoint, fetch.observed_at = fetch.end, evidence["observed_at"]
        else:
            # A failed recheck cannot leave an earlier successful response
            # available as fresh proof for this request.
            fetch.content_id = None
        fetch.result, fetch.fetched_at = result, now_ms()
        fetch.lease_token, fetch.lease_until = None, 0


def once(adapter=None):
    """One background source read; no alert/data mutation, no transaction over I/O."""
    from .config import settings
    from .market_resources import cooldown, lane
    from .oanda_stream import OandaPractice

    if adapter is None and (not settings.oanda_stream_enabled or not settings.oanda_token
                            or not settings.oanda_account_id):
        return False
    ownership = claim()
    if not ownership:
        return False
    owns = adapter is None
    evidence, result = None, "empty_success"
    try:
        adapter = adapter or OandaPractice(token=settings.oanda_token, account_id=settings.oanda_account_id,
                                          proxy=settings.oanda_proxy or settings.market_proxy)
        with lane("history"):
            evidence = adapter.confirm_daily_price(ownership["source"], ownership["start"], ownership["end"])
        if evidence is not None:
            result = "data"
    except Exception as error:
        failure = failed_request(error, observed_at=now_ms())
        result = failure.status
        if result == "rate_limited":
            cooldown("oanda", retry_seconds=max(1, (failure.retry_at-now_ms())/1000) if failure.retry_at else None)
    finally:
        if owns and adapter is not None:
            adapter.close()
    commit(ownership, evidence, result)
    return True
