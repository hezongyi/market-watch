"""Cross-process OANDA ownership and transactional source-isolated snapshots.

Network I/O is always outside database transactions. Every publish locks and
checks the account lease token, connection epoch and expiry before touching state.
"""

import hashlib
import math
import random
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from .calendar_profile import session_from
from .config import settings
from .live_session import effective_profile, session_evidence, session_status
from .market_contracts import DatasetIdentity, MarketRequestError, QuoteEvent, RequestResult
from .market_datasets import register_dataset
from .storage import (
    Audit,
    Instrument,
    LiveMinute,
    LiveState,
    MarketDataset,
    Preference,
    PricingOwner,
    Watch,
    now_ms,
    transaction,
    uid,
)


def account_key(account):
    return hashlib.sha256(("oanda:practice:" + account).encode()).hexdigest()


def ensure_catalog(items, account, *, ownership=None):
    scope = "sha256:" + hashlib.sha256(account.encode()).hexdigest()
    by_symbol = {row["name"]: row for row in items}
    resident = tuple(symbol.strip() for symbol in settings.oanda_resident_symbols.split(",") if symbol.strip())
    if any(symbol not in by_symbol for symbol in resident):
        raise ValueError("Resident instruments are unavailable in this practice account")
    with transaction() as db:
        if ownership is not None:
            if ownership[0] != account_key(account):
                raise ValueError('Catalog ownership account mismatch')
            lock_owner(db, ownership)
        for symbol, meta in by_symbol.items():
            logical = symbol.replace("_", "")
            if len(logical) > 10:
                continue
            identity = DatasetIdentity(source="oanda", channel="v20", environment="practice",
                account_scope=scope, provider_symbol=symbol, basis="bid",
                calendar_version=settings.oanda_calendar_version)
            inst = register_dataset(db, identity, logical_symbol=logical,
                label=meta.get("displayName", symbol), calendar="ny17", precision=meta["displayPrecision"],
                volume_kind="price_count", volume_unit="quotes",
                calendar_profile=settings.oanda_calendar_profiles.get(symbol))
            if symbol in resident:
                inst.enabled = True
            if not db.get(LiveState, identity.key):
                db.add(LiveState(dataset_id=identity.key))
    return resident


def _desired_dataset_identities(account):
    scope = "sha256:" + hashlib.sha256(account.encode()).hexdigest()
    residents = {symbol.strip() for symbol in settings.oanda_resident_symbols.split(",") if symbol.strip()}
    with transaction() as db:
        from .market_usage import composite_targets, wanted_instruments

        wanted = wanted_instruments(db)
        targets = composite_targets(db, wanted)
        result = []
        for row in db.scalars(select(MarketDataset)):
            identity = DatasetIdentity.model_validate(row.identity)
            if (identity.source, identity.channel, identity.environment, identity.account_scope) != (
                    "oanda", "v20", "practice", scope):
                continue
            if identity.calendar_version != settings.oanda_calendar_version:
                continue
            if identity.provider_symbol in residents or row.instrument_id in wanted or row.id in targets:
                result.append(identity)
        return tuple(sorted(result, key=lambda identity: identity.key))


def desired_dataset_identities(account):
    """Return live datasets without compressing identity by provider symbol."""
    return _desired_dataset_identities(account)


def desired_datasets(account):
    """Compatibility symbol map used by the existing stream lifecycle."""
    return {identity.provider_symbol: identity for identity in _desired_dataset_identities(account)}


def desired_native_provider_datasets(account):
    """Active OANDA native-period provider datasets for shared REST polling.

    Native chart interests live in ``ProviderInterest`` rather than
    ``MarketDataset``.  Returning the dataset rows lets the account worker
    batch H1/D1 (and non-default side/alignment) with the same full
    ``CandleSpec`` identity instead of falling back to M1/BID by symbol.
    """
    scope = "sha256:" + hashlib.sha256(account.encode()).hexdigest()
    from .provider_cache import identity as provider_identity
    from .storage import ProviderDataset, ProviderInterest

    with transaction() as db:
        rows = db.execute(select(ProviderDataset).join(
            ProviderInterest, ProviderInterest.dataset_id == ProviderDataset.id
        ).where(
            ProviderDataset.source == "oanda",
            ProviderInterest.subscribed.is_(True),
            ProviderInterest.expires > now_ms(),
        )).scalars().all()
        result = []
        for row in rows:
            identity = (row.metadata_json or {}).get("native_period_identity")
            if (isinstance(identity, dict) and identity.get("account_scope") == scope
                    and row.id == provider_identity(row.metadata_json, row.timeframe)):
                result.append(row)
        return tuple(sorted({row.id: row for row in result}.values(), key=lambda row: row.id))


def claim(account, *, now=None, startup=False):
    stamp = now_ms() if now is None else now
    key = account_key(account)
    with transaction() as db:
        insert = pg_insert if db.get_bind().dialect.name == "postgresql" else sqlite_insert
        db.execute(insert(PricingOwner).values(id=key, expires=0, epoch=0, connected_at=0,
            next_at=0, failures=0).on_conflict_do_nothing(index_elements=["id"]))
        owner = db.scalar(select(PricingOwner).where(PricingOwner.id == key).with_for_update())
        if owner.expires > stamp or owner.next_at > stamp or owner.error == "unauthorized":
            return None
        owner.token = uid()
        owner.expires = stamp + (120 if startup else settings.oanda_stream_lease_seconds) * 1000
        return (key, owner.token)


def claim_auth_probe(account, *, now=None):
    """Reserve the next probe before I/O, including after a worker crash."""
    stamp = now_ms() if now is None else now
    key = account_key(account)
    with transaction() as db:
        owner = db.scalar(select(PricingOwner).where(PricingOwner.id == key).with_for_update())
        if not owner or owner.error != 'unauthorized' or owner.expires > stamp or owner.next_at > stamp:
            return None
        owner.token = uid()
        # Three bounded HTTP requests plus their independent slot waits.
        owner.expires = stamp + 120000
        owner.next_at = stamp + settings.oanda_auth_probe_seconds * 1000
        return key, owner.token


def wait_delay(account, *, now=None):
    stamp = now_ms() if now is None else now
    with transaction() as db:
        owner = db.get(PricingOwner, account_key(account))
        deadlines = [value for value in (owner.expires, owner.next_at) if value > stamp] if owner else []
        return min(10, max(1, (min(deadlines) - stamp) / 1000)) if deadlines else 1


def _account_states(db, account):
    scope = 'sha256:' + hashlib.sha256(account.encode()).hexdigest()
    return [(state, dataset) for state, dataset in db.execute(select(LiveState, MarketDataset).join(
        MarketDataset, MarketDataset.id == LiveState.dataset_id)) if all(dataset.identity.get(key) == value
        for key, value in {'source': 'oanda', 'channel': 'v20', 'environment': 'practice', 'account_scope': scope}.items())]


def _retry_at(result, stamp, failures):
    delay = (settings.oanda_auth_probe_seconds * 1000 if result.status == 'unauthorized' else
             settings.oanda_maintenance_probe_seconds * 1000 if result.status == 'provider_maintenance' else
             int(min(60000, 1000 * 2 ** max(0, failures - 1)) * random.uniform(0.8, 1.2)))
    return max(stamp + delay, result.retry_at or 0)


def startup_failed(ownership, account, result, *, now=None):
    """Persist startup faults under the same account lease as collection."""
    stamp = now_ms() if now is None else now
    if ownership[0] != account_key(account):
        raise ValueError('Startup ownership account mismatch')
    with transaction() as db:
        owner = lock_owner(db, ownership, now=stamp)
        if owner.error == 'unauthorized' or (
                owner.error == 'provider_maintenance' and result.status != 'unauthorized'):
            result = RequestResult(status=owner.error)
        owner.failures = min(owner.failures + 1, 10)
        owner.error = result.status
        db.merge(Preference(key='oanda_probe_status:' + owner.id, value={}))
        owner.next_at = _retry_at(result, stamp, owner.failures)
        owner.expires, owner.token = 0, None
        for state, _ in _account_states(db, account):
            state.connection, state.error, state.ready = 'disconnected', result.status, False
            state.revision += 1


def finish_auth_probe(ownership, result, *, now=None, retry_seconds=None):
    stamp = now_ms() if now is None else now
    with transaction() as db:
        owner = lock_owner(db, ownership, now=stamp)
        if owner.error != 'unauthorized':
            raise TimeoutError('Authentication probe was superseded')
        owner.expires, owner.token = 0, None
        if result.successful:
            owner.error, owner.failures, owner.next_at = None, 0, 0
        else:
            # Maintenance/timeout must not clear a persisted auth hold.
            delay = max(settings.oanda_auth_probe_seconds, retry_seconds or 0)
            owner.next_at = max(stamp + int(delay * 1000), result.retry_at or 0)
        db.merge(Preference(key='oanda_probe_status:' + ownership[0],
            value={'error': None if result.successful else result.status, 'observed_at': stamp}))
        db.add(Audit(kind='pricing_auth_probe', details={'account_key': ownership[0],
            'effective_at': stamp, 'result': result.status, 'hold_released': result.successful}))


def provider_status(*, now=None):
    with transaction() as db:
        owner = db.get(PricingOwner, account_key(settings.oanda_account_id)) if settings.oanda_account_id else None
        probe = db.get(Preference, 'oanda_probe_status:' + owner.id) if owner else None
        held = bool(owner and owner.error == 'unauthorized')
        probe_error = probe.value.get('error') if probe and held else None
        return {'source': 'oanda', 'environment': 'practice', 'authentication_hold': held,
            'error': (probe_error or owner.error) if owner else None,
            'next_probe_at': owner.next_at or None if owner else None,
            'configured': bool(settings.oanda_account_id and settings.oanda_token),
            'collection_recorded': owner is not None,
            'connection_started_at': owner.connected_at or None if owner else None,
            'authentication_probe_at': probe.value.get('observed_at') if probe else None,
            # Probe time belongs only to that probe's error, never to a stream
            # fault or the original persisted authentication hold.
            'error_observed_at': probe.value.get('observed_at') if probe_error else None}


def session_states(identities, *, now=None):
    stamp = now_ms() if now is None else now
    with transaction() as db:
        result = {}
        for symbol, identity in identities.items():
            dataset = db.get(MarketDataset, identity.key)
            inst = db.get(Instrument, dataset.instrument_id) if dataset else None
            result[symbol] = session_status(identity.model_dump(), inst.calendar_profile if inst else {}, stamp)
        return result


def park_closed(ownership, identities, seconds, *, now=None):
    stamp = now_ms() if now is None else now
    if identities and any(row['market_session'] != 'closed'
                          for row in session_states(identities, now=stamp).values()):
        raise ValueError('A closed-market pause requires verified source session evidence')
    with transaction() as db:
        owner = lock_owner(db, ownership, now=stamp)
        if owner.error == 'unauthorized':
            raise TimeoutError('Authentication hold cannot be released by closure')
        if owner.error == 'provider_maintenance':
            raise MarketRequestError(RequestResult(status='provider_maintenance'))
        owner.next_at = stamp + int(seconds * 1000)
        owner.expires, owner.token, owner.error, owner.failures = 0, None, None, 0
        for identity in identities.values():
            state = db.get(LiveState, identity.key)
            state.connection, state.ready, state.error = 'closed', False, None
            state.revision += 1
            inst = db.get(Instrument, db.get(MarketDataset, identity.key).instrument_id)
            inst.quality, inst.error = 'waiting', None


def lock_owner(db, ownership, epoch=None, *, now=None):
    stamp = now_ms() if now is None else now
    key, token = ownership
    owner = db.scalar(select(PricingOwner).where(PricingOwner.id == key).with_for_update())
    if not owner or owner.token != token or owner.expires <= stamp or (epoch is not None and owner.epoch != epoch):
        raise TimeoutError("Pricing ownership expired or superseded")
    return owner


def renew(ownership, *, now=None):
    stamp = now_ms() if now is None else now
    try:
        with transaction() as db:
            owner = lock_owner(db, ownership, now=stamp)
            owner.expires = stamp + settings.oanda_stream_lease_seconds * 1000
        return True
    except TimeoutError:
        return False


def required_recovery_minutes(watches):
    from .domain import TIMEFRAMES
    from .indicators import get_indicator

    minutes = settings.oanda_recovery_minutes
    for watch in watches:
        rule = watch.rule
        if rule["timeframe"] == "tick":
            continue
        lookback = (get_indicator(rule["indicator"], rule["indicator_version"]).lookback(
            rule["indicator_params"]) + 2 if rule["kind"] == "indicator" else rule["consecutive"] + 2)
        minutes = max(minutes, int(lookback * TIMEFRAMES[rule["timeframe"]] / 60 * 1.6))
        if rule["kind"] == "previous_day":
            minutes = max(minutes, 5 * 1440)
    return minutes


def recovery_requirements(identities):
    with transaction() as db:
        result = {}
        for identity in identities.values():
            dataset = db.get(MarketDataset, identity.key)
            result[identity.key] = required_recovery_minutes(db.scalars(select(Watch).where(
                Watch.instrument_id == dataset.instrument_id, Watch.status == "active")))
        return result


def begin_connection(ownership, identities, *, now=None):
    stamp = now_ms() if now is None else now
    with transaction() as db:
        owner = lock_owner(db, ownership, now=stamp)
        if owner.error == 'unauthorized':
            raise TimeoutError('Account authentication hold')
        if owner.error == 'provider_maintenance':
            # Only a newly claimed connection epoch retires the prior pause.
            owner.error = None
        owner.epoch += 1
        owner.connected_at = stamp
        scopes = {identity.account_scope for identity in identities.values()}
        subscribed = {identity.key for identity in identities.values()}
        for state, dataset in db.execute(select(LiveState, MarketDataset).join(
                MarketDataset, MarketDataset.id == LiveState.dataset_id)):
            if dataset.identity["account_scope"] in scopes and state.dataset_id not in subscribed:
                state.connection = "inactive"
                state.ready = False
                state.revision += 1
                db.get(Instrument, dataset.instrument_id).enabled = False
        for identity in identities.values():
            state = db.get(LiveState, identity.key)
            if not state:
                raise ValueError("Unregistered live dataset")
            from .display_observations import handover_legacy

            handover_legacy(db, state)
            from .live_confirmation import outcome

            outcome(db, state, stamp=stamp, reset=True)
            state.epoch = owner.epoch
            state.connection = "connecting"
            state.ready = False
            state.forming = {}
            state.recovery_started = stamp
            cutoff = confirmation_cutoff(stamp)
            dataset = db.get(MarketDataset, identity.key)
            db.get(Instrument, dataset.instrument_id).enabled = True
            watches = list(db.scalars(select(Watch).where(Watch.instrument_id == dataset.instrument_id,
                                                        Watch.status == "active")))
            # Reserve a calendar span; actual observation readiness is still
            # checked by each rule evaluator and never inferred from its size.
            required_minutes = required_recovery_minutes(watches)
            state.recovery_cursor = max(0, min(
                state.confirmed_end - 2 * 60000 if state.confirmed_end else cutoff,
                cutoff - required_minutes * 60000))
            state.next_confirm_at = stamp
            state.attempts = 0
            state.error = None
            state.revision += 1
            db.add(Audit(kind="pricing_connection", details={"dataset": identity.key,
                "epoch": owner.epoch, "effective_at": stamp, "state": "recovering"}))
            for watch in watches:
                if watch.rule.get("timeframe") == "tick":
                    watch.state = {}
                watch.paused_reason = "行情连接恢复中，等待同源数据补齐"
        return owner.epoch


def publish_event(ownership, epoch, event, identities, *, now=None):
    """Return a bounded outcome only after the fenced transaction commits."""
    stamp = now_ms() if now is None else now
    with transaction() as db:
        owner = lock_owner(db, ownership, epoch, now=stamp)
        if owner.error == 'unauthorized':
            raise TimeoutError('Account authentication hold')
        if owner.error == 'provider_maintenance':
            return 'rejected_provider_maintenance'
        owner.expires = stamp + settings.oanda_stream_lease_seconds * 1000
        if not isinstance(event, QuoteEvent):
            if event.get("type") != "heartbeat" or event.get("connection_epoch") != epoch:
                raise ValueError("Invalid heartbeat generation")
            for identity in identities.values():
                state = db.get(LiveState, identity.key)
                state.heartbeat_at = event["received_at"]
                if state.connection == "connecting":
                    state.connection = "recovering"
                state.revision += 1
            return "heartbeat"
        if event.connection_epoch != epoch or event.identity not in identities.values():
            raise ValueError("Quote belongs to another connection or dataset")
        state = db.get(LiveState, event.identity.key)
        if state.epoch != epoch:
            raise TimeoutError("Quote generation is obsolete")
        from .display_observations import handover_legacy

        handover_legacy(db, state)
        previous = state.quote
        if previous and event.source_time < previous["source_time"]:
            return "rejected_old_source"
        if previous and previous["connection_epoch"] == epoch and event.sequence <= previous["sequence"]:
            return "rejected_sequence"
        if previous and previous["source_time"] == event.source_time and all(
                previous.get(field) == getattr(event, field) for field in ("bid", "ask", "tradeable")):
            return "rejected_duplicate"
        state.quote = event.model_dump(mode="json")
        state.received_at = event.received_at
        state.connection = "connected" if state.ready else "recovering"
        state.revision += 1
        minute = event.source_time // 60000 * 60000
        observation = _minute_observation(db, event.identity, state, minute, stamp)
        if observation.expected is not True and event.tradeable and event.bid is not None:
            observation.expected = True
            observation.expectation = "observed_source_tradeable"
        age = event.received_at - event.source_time
        bucket = str(age // 10 * 10)
        histogram = observation.age_histogram or {}
        observation.age_histogram = {**histogram, bucket: histogram.get(bucket, 0) + 1}
        observation.quote_count = (observation.quote_count or 0) + 1
        if previous and previous["connection_epoch"] == epoch:
            observation.max_interarrival = max(observation.max_interarrival or 0,
                event.received_at - previous["received_at"])
        if event.bid is not None:
            start = event.source_time // 60000 * 60000
            forming = state.forming
            if not forming or forming["start"] != start:
                forming = {"start": start, "end": start + 60000, "open": event.bid,
                    "high": event.bid, "low": event.bid, "close": event.bid, "complete": False,
                    "volume": None, "volume_kind": "unavailable", "observation_complete": False,
                    "connection_epoch": epoch, "source": "oanda"}
            else:
                forming = {**forming, "high": str(max(Decimal(forming["high"]), Decimal(event.bid))),
                           "low": str(min(Decimal(forming["low"]), Decimal(event.bid))), "close": event.bid}
            state.forming = forming
        dataset = db.get(MarketDataset, event.identity.key)
        inst = db.get(Instrument, dataset.instrument_id)
        from .display_observations import accept

        accept(db, state, event, stamp=stamp, profile=inst.calendar_profile)
        inst.last_received = event.received_at
        inst.quality = "receiving" if state.ready else "recovering"
        if (not event.tradeable or event.bid is None or event.ask is None or
                event.ask is not None and event.bid is not None and Decimal(event.ask) < Decimal(event.bid) or
                previous and event.source_time - previous["source_time"] > 15000):
            for watch in db.scalars(select(Watch).where(Watch.instrument_id == inst.id,
                                                       Watch.status == "active")):
                if watch.rule["timeframe"] == "tick":
                    watch.state = {}
                    watch.paused_reason = "报价期间缺少连续观测，重新建立同源判断前态"
        from .live_confirmation import health

        if (state.ready and not state.error and not health(db, state).get("error") and session_status(event.identity.model_dump(), inst.calendar_profile, stamp)['market_session'] != 'closed'
                and event.tradeable and event.bid is not None and event.ask is not None
                and Decimal(event.ask) >= Decimal(event.bid)
                and 0 <= stamp - event.source_time <= 15000):
            from .service import evaluate_quote

            evaluate_quote(db, inst, event.source_time, Decimal(event.bid), Decimal(event.ask))
        return "accepted"


def publish_rest_batch(ownership, epoch, batch, identities, *, now=None, demand_revision=None):
    """Fence and publish one shared ``candles/latest`` response.

    Confirmed candles are committed through the existing immutable input path
    before the forming candle is admitted to display and close-sample alerts.
    A response can contain an old completed candle and a newer provisional
    candle; each keeps its own source identity and acceptance boundary.
    """
    from .oanda_rest_batch import CandleSpec, LatestBatch, live_demand_revision

    batch = LatestBatch.model_validate(batch)
    if batch.generation != epoch:
        raise TimeoutError("REST batch generation is obsolete")
    expected_demand = demand_revision or live_demand_revision(
        CandleSpec.from_dataset(identity) for identity in identities.values())
    if batch.demand_revision != expected_demand:
        raise TimeoutError("REST batch demand is obsolete")

    # Complete rows must win over a provisional row for the same minute. Each
    # row is a one-minute bounded CandleBatch, so a two-candle latest response
    # never turns a missing interval into an implied coverage checkpoint. The
    # latest endpoint repeats the previous complete candle on every poll; do
    # not re-run ingestion, aggregation and watch evaluation when its immutable
    # source content is unchanged. A later minute or a real revision remains a
    # full confirmation so recovery and correction semantics stay intact.
    confirmed = [confirmed for identity in identities.values()
                 for confirmed in batch.confirmed_minutes(identity)]
    for pending in _pending_rest_confirmations(ownership, epoch, confirmed, now=now):
        commit_confirmation(ownership, epoch, pending, now=now, operation="candles_latest")

    stamp = now_ms() if now is None else now
    with transaction() as db:
        owner = lock_owner(db, ownership, epoch, now=stamp)
        if owner.error == 'unauthorized':
            raise TimeoutError('Account authentication hold')
        if owner.error == 'provider_maintenance':
            return 'rejected_provider_maintenance'
        owner.expires = stamp + settings.oanda_stream_lease_seconds * 1000
        from .display_observations import accept_rest
        from .service import evaluate_close_sample

        for identity in identities.values():
            state = db.get(LiveState, identity.key)
            dataset = db.get(MarketDataset, identity.key)
            if not state or not dataset or state.epoch != epoch:
                raise TimeoutError("REST dataset generation is obsolete")
            series = next((row for row in batch.series if row.spec == CandleSpec.from_dataset(identity)), None)
            if series is None:
                continue
            from .live_confirmation import sampling_evidence

            sampling_evidence(db, state, result=series.result)
            if not series.result.successful:
                state.error = series.result.status
                state.connection = 'recovering'
                state.ready = False
                state.revision += 1
                continue
            sample = batch.current_observation(
                series.spec, committed_at=stamp,
                recovery='ready' if state.ready else 'pending',
                previous=None if not state.forming else _previous_rest_sample(state.forming),
            )
            if sample is None:
                # A successful response containing only an old completed row
                # must not refresh current-price freshness.
                continue
            inst = db.get(Instrument, dataset.instrument_id)
            observation = accept_rest(db, state, sample, stamp=stamp,
                                      profile=inst.calendar_profile)
            if observation is None:
                continue
            state.connection = 'connected' if state.ready else 'recovering'
            state.error = None
            state.received_at = sample.received_at
            state.heartbeat_at = sample.received_at
            state.revision += 1
            # A forming candle observed while the source is still recovering
            # is display-only.  Advancing a tick rule here would create a new
            # baseline from a potentially incomplete prefix and could emit a
            # crossing before the confirmation gate has been rebuilt.  The
            # next ready-generation sample will establish/evaluate it.
            from .live_confirmation import health

            if sample.recovery == "ready" and state.ready and not health(db, state).get("error"):
                evaluate_close_sample(
                    db, inst, sample.received_at, sample.close,
                    received_at=sample.received_at, sequence=sample.sequence,
                    source_identity=sample.spec.identity.model_dump(mode='json'),
                    interval_ms=sample.interval_ms,
                )
    return 'accepted'


def _pending_rest_confirmations(ownership, epoch, batches, *, now=None):
    """Filter repeated complete latest rows without weakening ownership fencing."""
    if not batches:
        return ()
    stamp = now_ms() if now is None else now
    from .source_registry import collection_identity
    from .storage import SourceMinute, SourceMinuteRevision

    def canonical(row):
        data = row.model_dump()
        for field in ("open", "high", "low", "close", "volume"):
            if data[field] is not None:
                data[field] = format(Decimal(data[field]).normalize(), "f")
        data.update(volume_kind="price_count", volume_unit="quotes")
        return data

    with transaction() as db:
        owner = lock_owner(db, ownership, epoch, now=stamp)
        if owner.error == "unauthorized":
            raise TimeoutError("Account authentication hold")
        if owner.error == "provider_maintenance":
            raise MarketRequestError(RequestResult(status="provider_maintenance"))
        pending = []
        for batch in batches:
            state = db.get(LiveState, batch.identity.key)
            if not state or state.epoch != epoch:
                raise TimeoutError("Confirmation generation is obsolete")
            source = collection_identity(batch.identity)
            needs_commit = state.confirmed_end < max(row.timestamp + 60000 for row in batch.rows)
            if not needs_commit:
                for row in batch.rows:
                    head = db.get(SourceMinute, (source.key, row.timestamp))
                    revision = db.get(SourceMinuteRevision, head.revision_id) if head else None
                    if not revision or revision.data != canonical(row):
                        needs_commit = True
                        break
            if needs_commit:
                pending.append(batch)
        return tuple(pending)


def _previous_rest_sample(forming):
    """Return only the previous REST observation metadata needed for cadence."""
    from .oanda_rest_batch import CandleSpec, CloseObservation, RestCandle

    try:
        return CloseObservation(
            spec=CandleSpec.from_source(forming['source_identity']),
            candle=RestCandle.model_validate({key: forming[key] for key in (
                'start', 'end', 'open', 'high', 'low', 'close', 'volume', 'complete')}),
            generation=forming['connection_epoch'], sequence=forming['sequence'],
            demand_revision=forming['observation']['demand_revision'],
            requested_at=forming['observation']['requested_at'],
            received_at=forming['observation']['received_at'],
            committed_at=forming['observation']['committed_at'],
            recovery=forming['observation']['recovery'],
            interval_ms=forming['observation'].get('interval_ms'))
    except (KeyError, TypeError, ValueError):
        return None


def disconnected(ownership, epoch, identities, result, *, now=None, intentional=False):
    stamp = now_ms() if now is None else now
    with transaction() as db:
        owner = lock_owner(db, ownership, epoch, now=stamp)
        if owner.error == 'unauthorized' or (
                owner.error == 'provider_maintenance' and result.status != 'unauthorized'):
            result = RequestResult(status=owner.error)
        if result.status in ('unauthorized', 'provider_maintenance'):
            intentional = False
        owner.failures = 0 if intentional else min(owner.failures + 1, 10)
        owner.next_at = 0 if intentional else _retry_at(result, stamp, owner.failures)
        owner.error = None if intentional else result.status
        db.merge(Preference(key='oanda_probe_status:' + owner.id, value={}))
        owner.expires = 0
        owner.token = None
        for identity in identities.values():
            state = db.get(LiveState, identity.key)
            if state and state.epoch == epoch:
                state.connection = "inactive" if intentional else "disconnected"
                state.ready = False
                state.error = None if intentional else result.status
                state.forming = {**state.forming, "observation_complete": False} if state.forming else {}
                state.revision += 1
                dataset = db.get(MarketDataset, identity.key)
                inst = db.get(Instrument, dataset.instrument_id)
                inst.quality = "waiting" if intentional else "error"
                inst.error = None if intentional else result.status
                if intentional:
                    inst.enabled = False
                    db.add(Audit(kind="pricing_idle", details={"dataset": identity.key,
                        "epoch": epoch, "effective_at": stamp}))
                    continue
                for watch in db.scalars(select(Watch).where(Watch.instrument_id == inst.id,
                                                            Watch.status == "active")):
                    watch.paused_reason = "主行情不可用；备用尚未接入，暂停依赖缺失数据的判断"
                db.add(Audit(kind="pricing_health", details={"dataset": identity.key,
                    "epoch": epoch, "state": "unavailable", "error": result.status,
                    "effective_at": stamp}))


def confirmation_cutoff(stamp):
    return max(0, (stamp - settings.oanda_confirmation_margin_seconds * 1000) // 60000 * 60000)


def confirmation_window(ownership, epoch, identity, *, now=None):
    stamp = now_ms() if now is None else now
    with transaction() as db:
        lock_owner(db, ownership, epoch, now=stamp)
        state = db.get(LiveState, identity.key)
        if state.epoch != epoch or state.next_confirm_at > stamp:
            return None
        cutoff = confirmation_cutoff(stamp)
        start = state.recovery_cursor if not state.ready else max(0, state.confirmed_end - 2 * 60000)
        start = min(start, max(0, cutoff - 2 * 60000))
        from .live_confirmation import health

        pending_health = health(db, state)
        if pending_health.get('open'):
            start = min(start, pending_health.get('window_start', start))
        # A later confirmed minute is not proof that earlier observations were
        # confirmed. Keep shared backfill demand across connections/restarts.
        from sqlalchemy import exists

        from .source_registry import collection_identity
        from .storage import ObservedMinute, SourceMinute

        pending = db.scalar(select(ObservedMinute.start).outerjoin(LiveMinute,
            (LiveMinute.dataset_id == ObservedMinute.dataset_id) & (LiveMinute.start == ObservedMinute.start)).where(
            ObservedMinute.dataset_id == identity.key, ObservedMinute.start < cutoff,
            (LiveMinute.last_attempt.is_(None)) | (LiveMinute.last_attempt <= stamp - 60000),
            ~exists(select(SourceMinute.start).where(
                SourceMinute.source_id == collection_identity(identity).key,
                SourceMinute.start == ObservedMinute.start)))
            .order_by(ObservedMinute.start).limit(1))
        if pending is not None:
            start = min(start, pending)
        # Bound the fenced ingestion transaction so heartbeat publishing and
        # lease renewal do not wait behind an entire multi-day recovery.
        end = min(cutoff, start + 240 * 60000)
        if start < 0 or end <= start:
            return None
        return start, end


def _minute_observation(db, identity, state, start, stamp, cache=None):
    metric = (cache.get(start) if cache is not None else db.scalar(select(LiveMinute).where(
        LiveMinute.dataset_id == identity.key, LiveMinute.start == start)))
    if metric and (metric.expected is True or metric.confirmed_at is not None):
        return metric
    quote = state.quote
    # A fresh source assertion is evidence of an open market; old assertions
    # cannot certify an entire disconnect or historical maintenance window.
    fresh = bool(quote) and start <= quote["source_time"] < start + 60000
    # A tradeable source observation proves this minute has data. One
    # nontradeable quote proves only that instant, never a whole-minute closure.
    expected = True if fresh and quote["tradeable"] and quote.get("bid") is not None else None
    expectation = "fresh_source_tradeable" if expected else "unknown_session"
    if expected is None:
        dataset = db.get(MarketDataset, identity.key)
        inst = db.get(Instrument, dataset.instrument_id)
        if session_status(identity.model_dump(), inst.calendar_profile, start)['market_session'] == 'closed':
            expected = False
            expectation = "reviewed_source_closure"
    if metric:
        metric.expected, metric.expectation = expected, expectation
        return metric
    metric = LiveMinute(dataset_id=identity.key, start=start, expected=expected,
        expectation=expectation, first_attempt=0,
        last_attempt=0, attempts=0, failures=0, last_result="pending")
    db.add(metric)
    if cache is not None:
        cache[start] = metric
    return metric


def commit_confirmation(ownership, epoch, batch, *, now=None, operation="candles"):
    stamp = now_ms() if now is None else now
    with transaction() as db:
        owner = lock_owner(db, ownership, epoch, now=stamp)
        if owner.error == 'unauthorized':
            raise TimeoutError('Account authentication hold')
        if owner.error == 'provider_maintenance' and batch.result.status != 'unauthorized':
            raise MarketRequestError(RequestResult(status='provider_maintenance'))
        state = db.get(LiveState, batch.identity.key)
        if not state or state.epoch != epoch:
            raise TimeoutError("Confirmation generation is obsolete")
        observations = {row.start: row for row in db.scalars(select(LiveMinute).where(
            LiveMinute.dataset_id == batch.identity.key,
            LiveMinute.start >= batch.window_start, LiveMinute.start < batch.window_end))}
        from .storage import ObservedMinute

        observed_starts = set(db.scalars(select(ObservedMinute.start).where(
            ObservedMinute.dataset_id == batch.identity.key,
            ObservedMinute.start >= batch.window_start, ObservedMinute.start < batch.window_end)))
        target = batch.window_end - 60000
        metric = _minute_observation(db, batch.identity, state, target, stamp, observations)
        for start in range(batch.window_start, batch.window_end, 60000):
            observation = _minute_observation(db, batch.identity, state, start, stamp, observations)
            observation.attempts += 1
            if not observation.first_attempt:
                observation.first_attempt = stamp
            observation.last_attempt = stamp
            observation.last_result = batch.result.status
            if start in observed_starts and observation.expected is not True:
                observation.expected, observation.expectation = True, 'observed_source_pending'
        state.revision += 1
        if not batch.result.successful:
            for observation in observations.values():
                observation.failures += 1
            state.attempts += 1
            from .live_confirmation import outcome

            outcome(db, state, error=batch.result.status,
                    evidence={**session_evidence(batch.identity.model_dump(),
                        db.get(Instrument, db.get(MarketDataset, batch.identity.key).instrument_id).calendar_profile, target),
                        **batch.result.model_dump(mode="json", exclude_none=True),
                        'expected': metric.expected, 'expectation': metric.expectation, 'observed_at': stamp,
                        "window_start": batch.window_start, "window_end": batch.window_end}, stamp=stamp)
            state.next_confirm_at = max(stamp + min(60000, 1000 * 2 ** min(state.attempts, 6)),
                                         batch.result.retry_at or 0)
            if batch.result.status in ('unauthorized', 'provider_maintenance'):
                # Fence every symbol immediately, before the stream thread
                # observes the confirmation thread's connection-stop event.
                owner.error = batch.result.status
                db.merge(Preference(key='oanda_probe_status:' + owner.id, value={}))
                owner.next_at = _retry_at(batch.result, stamp, owner.failures)
                state.ready = False
            return
        dataset = db.get(MarketDataset, batch.identity.key)
        inst = db.get(Instrument, dataset.instrument_id)
        from .composite_inputs import apply_minutes
        from .confirmed_minutes import record
        from .market import ingest
        from .storage import Bar

        # Legacy empty confirmations carry no checkpoint and no M1 to pin.
        # Preserve their independently reviewed closure path without inventing
        # canonical minutes or a query checkpoint. Data confirmations stay strict.
        if batch.rows:
            apply_minutes(db, record(db, batch))
        previous_rows = {row.start: row for row in db.scalars(select(Bar).where(
            Bar.instrument_id == inst.id, Bar.timeframe == "M1",
            Bar.start >= batch.window_start, Bar.start < batch.window_end))}
        revised = any(row.timestamp in previous_rows and any(
            getattr(previous_rows[row.timestamp], name) != Decimal(getattr(row, name))
            for name in ("open", "high", "low", "close")) for row in batch.rows)
        ingest(db, inst, batch.ingestion_payload())
        # Measure completed ingestion, rather than the entry into the fenced
        # transaction. An explicit test clock remains deterministic.
        db.flush()
        written_at = now_ms() if now is None else stamp
        confirmed = {row.timestamp for row in batch.rows}
        for start in range(batch.window_start, batch.window_end, 60000):
            _minute_observation(db, batch.identity, state, start, stamp, observations)
        for start in confirmed:
            observation = _minute_observation(db, batch.identity, state, start, stamp, observations)
            if observation.confirmed_at is None:
                observation.confirmed_at = written_at
            if observation.expected is not True:
                observation.expected = True
                observation.expectation = ("recovery_source_complete"
                    if start + 60000 < state.recovery_started - 30000 else "observed_source_complete")
            observation.last_result = "data"
        confirmation_audit = None
        if batch.rows:
            state.confirmed_end = max(state.confirmed_end, batch.rows[-1].timestamp + 60000)
            confirmation_audit = Audit(kind="pricing_confirmed", details={"dataset": batch.identity.key,
                "epoch": epoch, "window_start": batch.window_start, "window_end": batch.window_end,
                "confirmed": len(batch.rows), "observed_at": stamp,
                "transport_received_at": batch.observed_at,
                "write_completed_at": written_at,
                "last_confirmed_end": state.confirmed_end})
            db.add(confirmation_audit)
        if not state.ready:
            state.recovery_cursor = batch.window_end
        # Only confirmed target bars or an independently proven closure allow
        # the current open-market gate to recover. Empty success alone never does.
        current_confirmed = target in confirmed
        from .live_confirmation import health, outcome

        confirmation = health(db, state)
        pending_start = min(confirmation.get('window_start', batch.window_start), batch.window_start)
        pending_end = max(confirmation.get('window_end', batch.window_end), batch.window_end)
        # Sparse source data is normal. A query alone does not certify missing
        # minutes, but unknown empty minutes must not hold real later data hostage.
        # Previously observed minutes still require their actual backfill.
        pending_observations = list(db.scalars(select(LiveMinute).where(
            LiveMinute.dataset_id == batch.identity.key, LiveMinute.start >= pending_start,
            LiveMinute.start < pending_end, LiveMinute.expected.is_(True),
            LiveMinute.confirmed_at.is_(None))))
        fully_confirmed = (operation == 'candles' and batch.window_start <= pending_start
            and batch.window_end >= pending_end and not pending_observations
            and (bool(confirmed) or all(observations[at].expected is False
                for at in range(pending_start, pending_end, 60000))))
        if fully_confirmed:
            outcome(db, state, stamp=stamp)
        late = next((row for row in pending_observations if stamp >= row.start+90000), None)
        if operation == 'candles' and late:
            late.failures += 1
            outcome(db, state, error='m1_late', evidence={
                **session_evidence(batch.identity.model_dump(), inst.calendar_profile, late.start),
                'expected': True, 'expectation': late.expectation,
                'reason_code': 'EXPECTED_MINUTE_MISSING', 'observed_at': stamp,
                'window_start': late.start, 'window_end': late.start+60000}, stamp=stamp)
        if not state.ready and batch.window_end >= confirmation_cutoff(stamp):
            if current_confirmed or metric.expected is False:
                from .service import rewarm_watch

                for watch in db.scalars(select(Watch).where(Watch.instrument_id == inst.id,
                                                            Watch.status == "active")):
                    rewarm_watch(db, watch, until=state.recovery_started)
                state.ready = True
                state.connection = "connected"
                inst.error = None
                owner.failures = 0
                owner.error = None
                db.add(Audit(kind="pricing_recovered", details={"dataset": batch.identity.key,
                    "epoch": epoch, "confirmed_end": state.confirmed_end,
                    "effective_at": stamp, "historical_notifications": "suppressed"}))
        if state.ready and not state.error and not health(db, state).get('error') and current_confirmed and session_status(batch.identity.model_dump(), inst.calendar_profile, stamp)['market_session'] != 'closed':
            from .service import evaluate_watch, rewarm_watch

            emit_after = max(state.recovery_started, stamp - 30000)
            for watch in db.scalars(select(Watch).where(Watch.instrument_id == inst.id,
                                                       Watch.status == "active")):
                if watch.rule["timeframe"] != "tick":
                    # Recent source revisions repair input state without replaying
                    # expired notification events. Only the fresh tail can notify.
                    if revised:
                        rewarm_watch(db, watch, until=emit_after)
                    evaluate_watch(db, watch.id, emit_after=emit_after)
        if confirmation_audit is not None:
            db.flush()
            evaluated_at = now_ms() if now is None else stamp
            confirmation_audit.details = {**confirmation_audit.details,
                "evaluation_completed_at": evaluated_at,
                "m1_to_evaluation_ms": evaluated_at - batch.window_end,
                "processing_ms": evaluated_at - stamp,
                "timing_scope": "ingestion and watch computation flushed; excludes transaction commit and delivery"}
        if operation != "candles":
            return
        if current_confirmed or metric.expected is False:
            state.attempts = 0
            from .live_confirmation import outcome

            if fully_confirmed:
                outcome(db, state, stamp=stamp)
            state.next_confirm_at = (stamp + 1000 if health(db, state).get("open") else batch.window_end + 60000 + settings.oanda_confirmation_margin_seconds * 1000)
        elif not state.ready and state.recovery_cursor < confirmation_cutoff(stamp):
            state.next_confirm_at = stamp
        else:
            state.attempts += 1
            retry = (15000, 25000)[state.attempts - 1] if state.attempts <= 2 else 30000 + min(
                60000, 1000 * 2 ** min(state.attempts, 6))
            state.next_confirm_at = max(stamp + 1000, batch.window_end + retry)
            if metric.expected is True and stamp - batch.window_end > 120000:
                state.ready = False
                state.connection = "recovering"


def snapshots(*, now=None):
    stamp = now_ms() if now is None else now
    with transaction() as db:
        result = []
        source_cooldowns = {}
        configured_scope = 'sha256:' + hashlib.sha256(settings.oanda_account_id.encode()).hexdigest()
        owner = db.get(PricingOwner, account_key(settings.oanda_account_id)) if settings.oanda_account_id else None
        probe = db.get(Preference, 'oanda_probe_status:' + owner.id) if owner else None
        for state in db.scalars(select(LiveState)):
            if (state.epoch == 0 and not state.error and state.connection != 'closed') or state.connection == "inactive":
                continue
            dataset = db.get(MarketDataset, state.dataset_id)
            source = dataset.identity["source"]
            if source not in source_cooldowns:
                budget = db.get(Preference, "upstream_slots:" + source)
                deadline = budget.value.get("cooldown_until", 0) if budget else 0
                # Budget Retry-After durations may have fractional milliseconds.
                # Report only active shared REST cooldowns, rounded outward.
                source_cooldowns[source] = math.ceil(deadline) if deadline > stamp else None
            inst = db.get(Instrument, dataset.instrument_id)
            if state.epoch == 0 and not inst.enabled and state.connection != 'closed':
                continue
            session = session_from(effective_profile(dataset.identity, inst.calendar_profile))
            session_view = session_status(dataset.identity, inst.calendar_profile, stamp)
            scoped_owner = owner if dataset.identity.get('account_scope') == configured_scope and all(
                dataset.identity.get(key) == value for key, value in
                {'source': 'oanda', 'environment': 'practice', 'channel': 'v20'}.items()) else None
            authentication_hold = bool(scoped_owner and scoped_owner.error == 'unauthorized' or state.error == 'unauthorized')
            connection_error = state.error
            if scoped_owner and scoped_owner.error:
                connection_error = (probe.value.get('error') if probe and authentication_hold else None) or scoped_owner.error
            from .live_confirmation import health, sampling_evidence

            confirmation = health(db, state)
            quote = state.quote
            forming = state.forming or {}
            rest_sample = forming.get("acquisition_mode") == "rest_batch"
            age = stamp - quote["source_time"] if quote else None
            candle_age = stamp - state.received_at if rest_sample and state.received_at else None
            connected = state.connection != "disconnected" and (
                max(state.heartbeat_at, state.received_at) >= stamp - 15000)
            valid_quote = bool(quote and quote.get("bid") and quote.get("ask")
                and Decimal(quote["ask"]) >= Decimal(quote["bid"]))
            valid_candle = bool(rest_sample and forming.get("close") and forming.get("start") is not None
                and candle_age is not None and 0 <= candle_age <= 15000)
            quality = ('provider_maintenance' if connection_error == 'provider_maintenance' else
                       'unauthorized' if authentication_hold else
                       'market_closed' if session_view['market_session'] == 'closed' else
                       "unavailable" if not connected else "recovering" if not state.ready else
                       "not_tradeable" if quote and not quote["tradeable"] else
                       "stale" if ((not rest_sample and (age is None or age > 15000 or age < 0))
                                   or (rest_sample and not valid_candle)) else
                       "degraded" if state.error or confirmation.get("error") or (not rest_sample and not valid_quote) else "healthy")
            result.append({"dataset_id": dataset.id, "instrument_id": dataset.instrument_id,
                "logical_symbol": dataset.logical_symbol, "identity": dataset.identity,
                "revision": state.revision, "quote": quote, "forming": forming,
                "quality": quality, "connection": state.connection, "connection_epoch": state.epoch,
                "heartbeat_at": state.heartbeat_at, "last_confirmed_m1": state.confirmed_end,
                "cooldown_until": source_cooldowns[source],
                "recovery_ready": state.ready, "error": state.error,
                "confirmation_error": confirmation.get("error"), "confirmation_health": confirmation,
                "sampling_evidence": sampling_evidence(db, state),
                'session_configuration': session_evidence(dataset.identity, inst.calendar_profile, stamp // 60000 * 60000),
                **session_view, 'authentication_hold': authentication_hold,
                'connection_error': connection_error,
                'next_probe_at': scoped_owner.next_at or None if scoped_owner else None,
                "calendar_revision": inst.calendar_profile.get("revision", dataset.identity["calendar_version"]),
                "session_evidence": ({"url": session.evidence_url, "applicability": session.applicability,
                    "reviewed_start": session.reviewed_start.isoformat(), "reviewed_end": session.reviewed_end.isoformat()}
                    if session else None),
                "fallback_ready": False, "selection_epoch": state.epoch,
                "received_at": state.received_at, "quote_age_ms": age,
                "candle_age_ms": candle_age, "observation_mode":
                "candle_close_sample" if rest_sample else "stream_quote"})
            available = not authentication_hold and connection_error != 'provider_maintenance' and session_view['market_session'] != 'closed'
            result[-1]["quote_ready"] = bool(not rest_sample and available and connected and valid_quote and quote["tradeable"]
                and age is not None and 0 <= age <= 15000)
            result[-1]["sample_ready"] = bool(available and connected and not state.error and (valid_candle if rest_sample else valid_quote))
            result[-1]["candle_ready"] = bool(available and connected and state.ready and not state.error and not confirmation.get("error")
                and (valid_candle if rest_sample else True))
            result[-1]["precision"] = inst.precision
            result[-1]["alert_readiness"] = [{"watch_id": watch.id, "reason": watch.paused_reason,
                "status": watch.status} for watch in db.scalars(select(Watch).where(
                    Watch.instrument_id == inst.id, Watch.status == "active"))]
        return result


def measurements(dataset_id, *, since=0):
    with transaction() as db:
        rows = list(db.scalars(select(LiveMinute).where(LiveMinute.dataset_id == dataset_id,
                                                       LiveMinute.start >= since)))
        recovered = [row for row in rows if row.expectation == "recovery_source_complete" or (
            row.expectation == "observed_source_complete" and row.quote_count == 0 and (
                row.first_attempt == 0 or row.first_attempt - row.start - 60000 > 30000))]
        expected = [row for row in rows if row.expected is True and row not in recovered
                    and row.start + 60000 <= now_ms()]
        delays = sorted(row.confirmed_at - row.start - 60000 for row in expected if row.confirmed_at is not None)
        histogram = {}
        for row in rows:
            for bucket, count in row.age_histogram.items():
                histogram[int(bucket)] = histogram.get(int(bucket), 0) + count
        samples = sum(histogram.values())

        def percentile(percent):
            cumulative = 0
            for bucket, count in sorted(histogram.items()):
                cumulative += count
                if cumulative >= max(1, int(samples * percent + 0.999)):
                    return bucket
            return None

        return {"dataset_id": dataset_id, "expected": len(expected), "unknown": sum(
            row.expected is None for row in rows), "not_tradeable": sum(row.expected is False for row in rows),
            "confirmed": len(delays), "missing": sum(row.confirmed_at is None for row in expected),
            "confirmed_closures": sum(row.expected is False and row.expectation == "reviewed_source_closure"
                                      for row in rows),
            "late_over_30s": sum(value > 30000 for value in delays),
            "failed_attempts": sum(row.failures for row in rows),
            "recovery_confirmed": sum(row.confirmed_at is not None for row in recovered),
            "p95_ms": delays[math.ceil(len(delays)*0.95)-1] if delays else None,
            "p99_ms": delays[math.ceil(len(delays)*0.99)-1] if delays else None,
            "percentile_method": "nearest_rank",
            "quotes": {"samples": samples, "p50_age_ms": percentile(0.5),
                "p95_age_ms": percentile(0.95), "p99_age_ms": percentile(0.99),
                "max_interarrival_ms": max((row.max_interarrival for row in rows), default=0),
                "histogram_resolution_ms": 10, "clock_offset_verified": False},
            "meaning": "Live missing/late/failure denominators; historical recovery and unknown sessions are separate"}
