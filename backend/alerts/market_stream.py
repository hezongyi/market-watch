"""Session-owned subscriptions and fenced, shared result publication.

SSE reads durable results only. Supplier IO and expensive calculation belong to
the worker, never the number of consumers or API processes.
"""

import hashlib
import json

from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.orm import defer

from .source_history_store import _insert
from .storage import (
    LoginSession,
    MarketStreamClient,
    MarketStreamResult,
    MarketStreamSubscription,
    MarketStreamTask,
    now_ms,
    transaction,
    uid,
)

LEASE_MS = 120000
RESULT_LIMIT = 128
SUBSCRIPTION_LIMIT = 256
# The retained 2000-bar composite snapshot includes per-bar provenance and
# indicator values. It is larger than the window-filtered/delta wire result.
PAYLOAD_BYTES = 8 * 1024 * 1024
DELIVERY_BYTES = 4 * 1024 * 1024


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def client_key(session_hash, client):
    return digest([session_hash, client])


def _client(db, session_hash, client):
    session = db.get(LoginSession, session_hash)
    if not session or session.expires <= now_ms():
        raise PermissionError("会话已结束")
    ident = client_key(session_hash, client)
    locked = select(MarketStreamClient).where(MarketStreamClient.id == ident).with_for_update()
    owner = db.scalar(locked)
    while owner is None:
        db.execute(_insert(db)(MarketStreamClient).values(id=ident, session_hash=session_hash,
            client=client, expires=now_ms() + LEASE_MS).on_conflict_do_nothing(index_elements=["id"]))
        owner = db.scalar(locked)
    return owner


def _existing_client(db, session_hash, client):
    session = db.get(LoginSession, session_hash)
    if not session or session.expires <= now_ms():
        raise PermissionError("会话已结束")
    ident = client_key(session_hash, client)
    owner = db.get(MarketStreamClient, ident)
    if not owner or owner.session_hash != session_hash or owner.expires <= now_ms():
        raise PermissionError("行情连接租约已结束")
    return owner


def register(session_hash, client, listener, generation, identity, query, state):
    """Generation orders replacement and cancellation, including tombstones."""
    with transaction() as db:
        owner = _client(db, session_hash, client)
        ident = digest([owner.id, listener])
        # Resolved presentation metadata may change when a follow-active
        # composite switches baseline. It must not split its stable task key.
        key = digest({k: v for k, v in identity.items() if k != "metadata"})
        old = db.get(MarketStreamSubscription, ident)
        fresh = old is None or generation > old.generation
        if old and generation < old.generation:
            return {"generation": old.generation, "stale": True}
        if old and generation == old.generation:
            if not old.active:
                return {"generation": generation, "stale": True}
            if old.task_id != key:
                raise ValueError("相同订阅世代不能更换身份")
        count = db.scalar(select(func.count()).select_from(MarketStreamSubscription).where(
            MarketStreamSubscription.client_id == owner.id,
            MarketStreamSubscription.active.is_(True)))
        if (not old or not old.active) and count >= SUBSCRIPTION_LIMIT:
            raise ValueError("行情订阅数量超过预算")
        stamp = now_ms()
        previous_task = old.task_id if old else None
        # Replacement and last-consumer cancellation share task-row fencing
        # with publication. Consistent ordering also covers two clients that
        # concurrently exchange their old and new calculation identities.
        tasks = {}
        for task_id in sorted({key, previous_task} - {None}):
            locked = select(MarketStreamTask).options(defer(MarketStreamTask.payload)).where(
                MarketStreamTask.id == task_id).with_for_update()
            task = db.scalar(locked)
            # An expired orphan can disappear before the lock is acquired.
            # Acquire insertion locks in the same key order as existing rows;
            # ON CONFLICT DO NOTHING alone does not protect an existing Task.
            while task is None and task_id == key:
                db.execute(_insert(db)(MarketStreamTask).values(id=key, identity=identity, query=query,
                    sequence=0, payload={}, fingerprint="", lease_until=0, next_at=0,
                    updated_at=stamp, expires=stamp + LEASE_MS).on_conflict_do_nothing(index_elements=["id"]))
                task = db.scalar(locked)
            tasks[task_id] = task
        task = tasks[key]
        if not old:
            old = MarketStreamSubscription(id=ident, client_id=owner.id, listener=listener)
            db.add(old)
        state = dict(state)
        if not fresh and old.state.get("provider_acceptance"):
            from .provider_acceptance import merge
            # onopen may replay the original registration after an ack. Keep
            # newer per-bar acceptance instead of rolling it back with it.
            newer = [r for r in old.state["provider_acceptance"] if
                old.state.get("provider_acceptance_sequences", {}).get(str(r["start"]), 0)
                > state.get("sequence", 0)]
            state["provider_acceptance"] = merge(state.get("provider_acceptance", []), newer)
            state["provider_acceptance_sequences"] = old.state.get("provider_acceptance_sequences", {})
        if state.get("result_epoch") and state["result_epoch"] != task.result_epoch:
            state["sequence"] = max(0, task.sequence - 1)
            state["initial_snapshot"] = True
            state["epoch_changed"] = True
        if fresh and not state.get("sequence") and task.sequence:
            # A new binding starts with the authoritative latest snapshot. A
            # reconnect of the same generation retains its delivered cursor.
            state["sequence"] = task.sequence - 1
            state["initial_snapshot"] = True
        old.generation, old.task_id, old.active = generation, key, True
        old.state, old.expires = state, stamp + LEASE_MS
        owner.expires = stamp + LEASE_MS
        task.expires = max(task.expires, old.expires)
        if previous_task and previous_task != key:
            db.flush()
            if not db.scalar(select(MarketStreamSubscription.id).where(
                    MarketStreamSubscription.task_id == previous_task,
                    MarketStreamSubscription.active.is_(True),
                    MarketStreamSubscription.expires > stamp).limit(1)):
                _release_demand(db, tasks[previous_task])
        return {"generation": generation, "identity": identity, "sequence": task.sequence,
                "task_id": key, "result_epoch": task.result_epoch}


def cancel(session_hash, client, listener, generation):
    with transaction() as db:
        owner = _client(db, session_hash, client)
        ident = digest([owner.id, listener])
        sub = db.get(MarketStreamSubscription, ident)
        if sub and generation < sub.generation:
            return
        if not sub:
            sub = MarketStreamSubscription(id=ident, client_id=owner.id, listener=listener,
                                           state={}, expires=now_ms() + LEASE_MS)
            db.add(sub)
        task_id = sub.task_id
        task = db.scalar(select(MarketStreamTask).options(defer(MarketStreamTask.payload)).where(MarketStreamTask.id == task_id)
                         .with_for_update()) if task_id else None
        sub.generation, sub.active = generation, False
        if task_id:
            # A loaded legacy client may upload a durable fault after cancel.
            # Keep only this generation's owner for notice dedupe, not demand.
            sub.state = {**sub.state, '_notice_task_id': task_id}
        sub.task_id = None
        db.flush()
        if task_id and not db.scalar(select(MarketStreamSubscription.id).where(
                MarketStreamSubscription.task_id == task_id,
                MarketStreamSubscription.active.is_(True), MarketStreamSubscription.expires > now_ms()).limit(1)):
            _release_demand(db, task)


def accept_provider(session_hash, client, listener, generation, result_epoch, sequence, receipts):
    """Only the current consumer may acknowledge values from a retained result.

    Never reread mutable provider bars to mint acceptance: a repair can commit
    between publication and this acknowledgement.
    """
    from .provider_acceptance import BATCH, merge
    from .provider_acceptance import receipts as bar_receipts

    if not receipts or len(receipts) > BATCH:
        raise ValueError("无效行情接受批次")
    with transaction() as db:
        owner = _existing_client(db, session_hash, client)
        sub = db.scalar(select(MarketStreamSubscription).where(
            MarketStreamSubscription.id == digest([owner.id, listener])).with_for_update())
        if not sub or not sub.active or sub.generation != generation or sub.expires <= now_ms():
            return {"ok": False, "stale": True}
        task = db.get(MarketStreamTask, sub.task_id, options=[defer(MarketStreamTask.payload)])
        if (task.result_epoch != result_epoch or task.identity.get("kind") != "bars"
                or task.identity.get("series_kind") != "provider"):
            return {"ok": False, "stale": True}
        row = db.get(MarketStreamResult, (task.id, sequence))
        if not row:
            return {"ok": False, "stale": True}
        # A fresh binding can receive the retained full snapshot rather than
        # that sequence's delta. Both describe the same committed sequence.
        payload = row.payload
        requested = {receipt["start"] for receipt in receipts}
        expected = {r["start"]: r["fingerprint"] for r in bar_receipts(
            [bar for bar in payload.get("bars", []) if bar["start"] in requested],
            bool(task.query.get("indicators")))}
        if sequence == task.sequence and any(expected.get(r["start"]) != r["fingerprint"] for r in receipts):
            expected = {r["start"]: r["fingerprint"] for r in bar_receipts(
                [bar for bar in task.payload.get("bars", []) if bar["start"] in requested],
                bool(task.query.get("indicators")))}
        state = dict(sub.state)
        accepted = []
        sequences = dict(state.get("provider_acceptance_sequences", {}))
        for receipt in receipts:
            start = receipt["start"]
            if expected.get(start) != receipt["fingerprint"]:
                return {"ok": False, "stale": True}
            if sequence >= sequences.get(str(start), 0):
                accepted.append(receipt)
                sequences[str(start)] = sequence
        state["provider_acceptance"] = merge(state.get("provider_acceptance", []), accepted)
        state["provider_acceptance_sequences"] = {
            str(r["start"]): sequences.get(str(r["start"]), 0) for r in state["provider_acceptance"]}
        sub.state = state
        return {"ok": True}


def _release_demand(db, task, *, keep_revision=None):
    """Delete only this calculation's browser demand; alerts keep their owners."""
    from .storage import MarketComposite, MarketDemand, ProviderInterest
    if keep_revision is None:
        from .market_notices import end_observation
        end_observation(db, task)

    identity = task.identity
    if identity.get("series_kind") == "provider":
        db.execute(delete(ProviderInterest).where(ProviderInterest.client == "stream_" + task.id[:32]))
    elif identity.get("series_kind") in ("managed", "composite"):
        ident = identity["instrument"]
        if identity["series_kind"] == "composite":
            composite = db.get(MarketComposite, ident)
            if not composite:
                return
            ident = composite.instrument_id
        from .market_data import demand_id
        # A follow-active task may have created demand before a revision switch
        # or before another worker took over. Match exact task-owned IDs among
        # this instrument's demands rather than guessing its current revision.
        owned = [row.id for row in db.scalars(select(MarketDemand).where(
            MarketDemand.instrument_id == ident)) if (keep_revision is None or
            row.composite_revision_id != keep_revision) and
            row.id == demand_id("stream:" + task.id[:32], ident,
                                composite_revision_id=row.composite_revision_id)]
        if owned:
            db.execute(delete(MarketDemand).where(MarketDemand.id.in_(owned)))


def renew(session_hash, client):
    with transaction() as db:
        stamp = now_ms()
        owner = _existing_client(db, session_hash, client)
        deadline, renew_before = stamp + LEASE_MS, stamp + LEASE_MS * 2 // 3
        due = select(MarketStreamSubscription.id).where(
            MarketStreamSubscription.client_id == owner.id,
            MarketStreamSubscription.active.is_(True), MarketStreamSubscription.expires > stamp,
            MarketStreamSubscription.expires <= renew_before).exists()
        # Registration extends the page lease independently of its older
        # listeners. Neither clock may starve the other's renewal.
        if owner.expires > renew_before and not db.scalar(select(due)):
            return
        # Serialize the infrequent write phase with registration/cancellation;
        # idle delivery reads never acquire this write lock.
        owner = db.scalar(select(MarketStreamClient).where(
            MarketStreamClient.id == owner.id).with_for_update()
            .execution_options(populate_existing=True))
        if not owner or owner.expires <= stamp:
            raise PermissionError("行情连接租约已结束")
        due_tasks = select(MarketStreamSubscription.task_id).where(
            MarketStreamSubscription.client_id == owner.id,
            MarketStreamSubscription.active.is_(True), MarketStreamSubscription.expires > stamp,
            MarketStreamSubscription.expires <= renew_before)
        # Every lifecycle writer locks Client -> sorted Tasks -> Subscriptions.
        # A bulk UPDATE's physical scan order cannot provide this guarantee.
        task_ids = list(db.scalars(select(MarketStreamTask.id).where(
            MarketStreamTask.id.in_(due_tasks)).order_by(MarketStreamTask.id).with_for_update()))
        db.execute(update(MarketStreamClient).where(
            MarketStreamClient.id == owner.id,
            MarketStreamClient.expires <= renew_before).values(expires=deadline))
        db.execute(update(MarketStreamSubscription).where(
            MarketStreamSubscription.client_id == owner.id,
            MarketStreamSubscription.active.is_(True), MarketStreamSubscription.expires > stamp,
            MarketStreamSubscription.expires <= renew_before)
            .values(expires=deadline))
        if task_ids:
            db.execute(update(MarketStreamTask).where(
                MarketStreamTask.id.in_(task_ids), MarketStreamTask.expires < deadline).values(
                    expires=deadline))


def claim(exclude=(), owner=None):
    with transaction() as db:
        stamp = now_ms()
        active = select(MarketStreamSubscription.task_id).join(MarketStreamClient,
            MarketStreamSubscription.client_id == MarketStreamClient.id).join(LoginSession,
            MarketStreamClient.session_hash == LoginSession.token_hash).where(
                MarketStreamSubscription.active.is_(True), MarketStreamSubscription.expires > stamp,
                LoginSession.expires > stamp)
        task = db.scalar(select(MarketStreamTask).options(defer(MarketStreamTask.payload)).where(MarketStreamTask.id.in_(active),
            MarketStreamTask.id.not_in(exclude),
            or_(MarketStreamTask.owner_until <= stamp, MarketStreamTask.owner_token == owner),
            MarketStreamTask.next_at <= stamp, MarketStreamTask.lease_until <= stamp)
            .order_by(MarketStreamTask.next_at, MarketStreamTask.id)
            .with_for_update(skip_locked=True).limit(1))
        if not task:
            return None
        task.lease_token, task.lease_until = uid(), stamp + 30000
        if owner:
            task.owner_token, task.owner_until = owner, stamp + 30000
        return {"id": task.id, "token": task.lease_token, "identity": task.identity,
                "query": task.query, "sequence": task.sequence, "fingerprint": task.fingerprint,
                "input_signal": task.input_signal}


def commit(ownership, payload, *, delay_ms=500):
    if payload is not None and len(json.dumps(payload).encode()) > PAYLOAD_BYTES:
        payload = {"type": "reset", "reason": "result_budget"}
    with transaction() as db:
        task = db.scalar(select(MarketStreamTask).options(defer(MarketStreamTask.payload)).where(MarketStreamTask.id == ownership["id"])
                         .with_for_update())
        stamp = now_ms()
        if not task or task.lease_token != ownership["token"] or task.lease_until <= stamp:
            raise TimeoutError("行情计算租约已失效")
        if payload is not None:
            fingerprint = digest(payload)
            if task.fingerprint != fingerprint:
                task.sequence += 1
                wire = payload
                if payload.get("type") == "bars" and task.payload.get("type") == "bars":
                    old = {bar["start"]: bar for bar in task.payload.get("bars", [])}
                    current = {bar["start"] for bar in payload.get("bars", [])}
                    floor = min(current) if current else 0
                    removed = any(start >= floor and start not in current for start in old)
                    # Credentials change independently of prices. Keep them in
                    # metadata; emit current authoritative changed/new bars.
                    def prices(bar):
                        return {k: v for k, v in bar.items() if k not in ("input_revision", "segments")}

                    def indicator_values(page):
                        return {(indicator.get("id", index), series["key"], value["time"]): value
                                for index, indicator in enumerate(page.get("indicators", []))
                                for series in indicator["series"] for value in series["values"]}

                    previous_values, values = indicator_values(task.payload), indicator_values(payload)
                    indicator_changed = {key[2] for key in previous_values.keys() | values.keys()
                                         if previous_values.get(key) != values.get(key)}
                    changed = [bar for bar in payload.get("bars", []) if
                        bar["start"] not in old or prices(bar) != prices(old[bar["start"]])
                        or bar["start"] in indicator_changed]
                    wire = {**payload, "bars": changed,
                            "recovery_floor": payload["bars"][0].get("chart_time", payload["bars"][0]["start"])
                                if payload.get("bars") else None,
                            "latest_bar": payload["bars"][-1:] if payload.get("bars") else [],
                            "latest_time": payload["bars"][-1].get("chart_time", payload["bars"][-1]["start"])
                                if payload.get("bars") else None}
                    if changed:
                        begin = min(bar["start"] for bar in changed)
                        wire["indicators"] = [{**indicator, "series": [
                            {**series, "values": [value for value in series["values"] if value["time"] >= begin]}
                            for series in indicator["series"]]} for indicator in payload.get("indicators", [])]
                    if removed:
                        wire = {"type": "reset", "reason": "tail_retracted",
                                "resolved_revision_id": payload.get("resolved_revision_id"),
                                "status": payload.get("status")}
                task.payload, task.fingerprint = payload, fingerprint
                db.add(MarketStreamResult(task_id=task.id, sequence=task.sequence, payload=wire))
                db.execute(delete(MarketStreamResult).where(MarketStreamResult.task_id == task.id,
                    MarketStreamResult.sequence <= task.sequence - RESULT_LIMIT))
            from .market_notices import record_result
            record_result(db, task, payload, fingerprint=fingerprint)
        task.lease_token, task.lease_until = None, 0
        if "new_input_signal" in ownership:
            task.input_signal = ownership["new_input_signal"]
        task.next_at, task.updated_at = stamp + delay_ms, stamp
        if not db.scalar(select(MarketStreamSubscription.id).join(MarketStreamClient,
                MarketStreamSubscription.client_id == MarketStreamClient.id).join(LoginSession,
                MarketStreamClient.session_hash == LoginSession.token_hash).where(
                    MarketStreamSubscription.task_id == task.id,
                    MarketStreamSubscription.active.is_(True), MarketStreamSubscription.expires > stamp,
                    LoginSession.expires > stamp).limit(1)):
            # Cancellation may precede an already claimed worker's demand IO.
            # Publication finishes that work under the task lock and retires
            # only its browser demand if no valid consumer remains.
            _release_demand(db, task)
        return task.sequence


def events(session_hash, client, cursors):
    """Bounded replay or explicit reset; never assume SSE IDs prove continuity."""
    with transaction() as db:
        owner = _existing_client(db, session_hash, client)
        output = []
        size = 0
        for sub in db.scalars(select(MarketStreamSubscription).where(
                MarketStreamSubscription.client_id == owner.id,
                MarketStreamSubscription.active.is_(True), MarketStreamSubscription.expires > now_ms())):
            # The retained full snapshot is needed only for a fresh binding.
            # Idle checks and ordinary deltas read metadata/results instead.
            task = db.get(MarketStreamTask, sub.task_id, options=[defer(MarketStreamTask.payload)])
            key = (sub.listener, sub.generation)
            sequence = cursors.get(key, sub.state.get("sequence", 0))
            rows = list(db.scalars(select(MarketStreamResult).where(
                MarketStreamResult.task_id == task.id, MarketStreamResult.sequence > sequence)
                .order_by(MarketStreamResult.sequence).limit(RESULT_LIMIT)))
            common = {"listener": sub.listener, "generation": sub.generation, "identity": task.identity,
                      "result_epoch": task.result_epoch}
            from .config import settings
            if settings.notification_center_sources_enabled:
                common.update(notice_owner='server', task_id=task.id)
            if sequence > task.sequence or rows and rows[0].sequence != sequence + 1:
                output.append({**common, "type": "reset", "sequence": task.sequence,
                               "reason": "recovery_budget"})
                cursors[key] = task.sequence
                continue
            for row in rows:
                payload = row.payload
                result_sequence = row.sequence
                initial = cursors.setdefault((*key, "delivery"), dict(sub.state))
                snapshot = initial.pop("initial_snapshot", False)
                epoch_changed = initial.pop("epoch_changed", False)
                if snapshot:
                    payload = task.payload
                    result_sequence = task.sequence
                if payload.get("type") == "bars":
                    payload = delivery(db, task, sub, payload, cursors)
                elif payload.get("type") == "quotes":
                    snapshots = [quote["snapshot"] for quote in payload.get("quotes", [])
                                 if quote.get("snapshot")]
                    binding = snapshots[0].get("revision_id") if snapshots else None
                    previous_binding = initial.get("binding")
                    if binding:
                        initial["binding"] = binding
                    if binding and previous_binding and binding != previous_binding:
                        payload = {"type": "reset", "reason": "binding_changed",
                                   "resolved_revision_id": binding}
                if epoch_changed:
                    payload = {"type": "reset", "reason": "result_epoch_changed"}
                event = {**common, **payload, "sequence": result_sequence}
                weight = len(json.dumps(event).encode())
                if size + weight > DELIVERY_BYTES:
                    # An overflowing consumer receives a recovery instruction;
                    # other clients have independent delivery state.
                    event = {**common, "type": "reset", "reason": "delivery_budget", "sequence": task.sequence}
                    result_sequence = task.sequence
                    snapshot = True
                    weight = len(json.dumps(event).encode())
                output.append(event)
                size += weight
                cursors[key] = result_sequence
                if snapshot:
                    break
        live = {(s.listener, s.generation) for s in db.scalars(select(MarketStreamSubscription).where(
            MarketStreamSubscription.client_id == owner.id, MarketStreamSubscription.active.is_(True)))}
        for key in list(cursors):
            if key[:2] not in live:
                cursors.pop(key)
        return output


def delivery(db, task, sub, payload, cursors):
    """Consumer windows are checked independently of shared current-bar work."""
    from .chart_api import DataQuery
    from .chart_api import history_check as managed_check
    from .series_access import history_check as fixed_check
    from .storage import Instrument, ProviderBar, ProviderDataset

    key = (sub.listener, sub.generation)
    state = cursors.setdefault((*key, "delivery"), dict(sub.state))
    query = DataQuery.model_validate(task.query)
    page = dict(payload)
    check_page = {**page, "bars": page.get("latest_bar", page.get("bars", [])[-1:])}
    if not state.get("history_accepted", True):
        if query.series_kind == "managed" and query.published:
            from .chart_indicators import history_requirement
            from .managed_dataset import status
            ready = status(db, db.get(Instrument, query.instrument), query.timeframe,
                width=state.get("history_plot_width", 960), spacing=state.get("history_bar_spacing", 6),
                lookback=max([0] + [history_requirement(spec) for spec in query.indicators]))
            if not ready["ready"]:
                return {"type": "status", "status": ready["reason"]}
        if check_page["bars"]:
            return {"type": "reset", "reason": "initial_history_ready"}
        return {"type": "status", "status": "preparing", "pending": page.get("pending", [])}
    revision = payload.get("resolved_revision_id")
    previous_binding = state.get("binding", sub.state.get("binding"))
    if revision and previous_binding and previous_binding != revision:
        state["binding"] = revision
        return {"type": "reset", "reason": "binding_changed", "resolved_revision_id": revision}
    state["binding"] = revision
    before, after = state.get("loaded_before"), state.get("loaded_after")
    dependency_origin = state.get("dependency_origin")
    check = None
    display_verified = False
    if before is not None:
        query = query.model_copy(update={"track_history": True, "revision_before": before,
                                         "revision_after": after})
        if query.series_kind in ("history", "composite") and check_page.get("bars"):
            if query.series_kind == "composite" and state.get("initial_input_revision") is not None:
                from .composite_series import period
                from .storage import CompositeMinuteInput
                cutoff = period(before, query.timeframe, page["calendar"])[
                    1 if state.get("historical") else 0]
                floor = (page["origin"] if query.indicators else
                         period(after, query.timeframe, page["calendar"])[0] if after is not None else 0)
                previous_input_revision = state["initial_input_revision"]
                if state.get('display_snapshot_id') and page.get('display_snapshot_id'):
                    from .display_changes import changed_buckets

                    differences = changed_buckets(db, query.instrument, page['revision_id'], query.timeframe,
                        state['display_snapshot_id'], page['display_snapshot_id'], floor, cutoff, now_ms())
                    display_verified = differences is not None
                    if differences:
                        from .series_access import fixed_label

                        left = min(differences)
                        right = period(left, query.timeframe, page['calendar'])[1]
                        return {'type': 'reset', 'reason': 'history_changed', 'affected_start': left,
                            'affected_chart_time': fixed_label({'start': left, 'end': right}, query.timeframe, page['calendar'])}
                changed = db.scalar(select(CompositeMinuteInput.start).where(
                    CompositeMinuteInput.revision_id == page["revision_id"],
                    CompositeMinuteInput.input_revision > state["initial_input_revision"],
                    CompositeMinuteInput.input_revision <= page["input_revision"],
                    CompositeMinuteInput.start >= floor, CompositeMinuteInput.start < cutoff).limit(1))
                state["initial_input_revision"] = page["input_revision"]
                if changed is not None and not display_verified:
                    return {"type": "reset", "reason": "history_changed"}
                if dependency_origin is not None and dependency_origin < floor:
                    prefix = db.scalar(select(CompositeMinuteInput.start).where(
                        CompositeMinuteInput.revision_id == page["revision_id"],
                        CompositeMinuteInput.input_revision > previous_input_revision,
                        CompositeMinuteInput.input_revision <= page["input_revision"],
                        CompositeMinuteInput.start >= dependency_origin, CompositeMinuteInput.start < floor).limit(1))
                    if prefix is not None:
                        page["indicator_correction"] = True
            check = fixed_check(db, check_page, query, {"calendar": page["calendar"]})
        elif query.series_kind == "managed" and check_page.get("bars"):
            inst = db.get(Instrument, query.instrument)
            if query.published:
                from .managed_dataset import published_history_check
                from .storage import ChartPublication
                publication = db.get(ChartPublication, (inst.id, query.timeframe))
                check = published_history_check(db, inst, publication, check_page["bars"], query)
                if dependency_origin is not None and state.get("dependency_before"):
                    dependency = published_history_check(db, inst, publication, check_page["bars"],
                        query.model_copy(update={"indicators": [], "revision_after": None,
                            "dataset_start": max(query.dataset_start or 0, dependency_origin),
                            "revision_before": state["dependency_before"]}))
                    previous = state.get("dependency_revision")
                    if dependency and previous and previous != dependency["revision"]:
                        page["indicator_correction"] = True
                    if dependency:
                        state["dependency_revision"] = dependency["revision"]
            else:
                source = "M15" if query.timeframe == "M30" else "D1" if query.timeframe in ("W1", "MN") else query.timeframe
                check = managed_check(db, inst, source, check_page["bars"], query)
                if dependency_origin is not None and after is not None and dependency_origin < after:
                    from .storage import Bar
                    observed = state.get("dependency_observed_at") or state.get("observed_at", 0)
                    changed_at = db.scalar(select(func.max(Bar.received_at)).where(
                        Bar.instrument_id == inst.id, Bar.timeframe == source,
                        Bar.start >= dependency_origin, Bar.start < after, Bar.received_at > observed))
                    if changed_at is not None:
                        page["indicator_correction"] = True
                        state["dependency_observed_at"] = changed_at
        elif query.series_kind == "provider":
            from .provider_acceptance import LIMIT, fingerprint
            dataset = db.get(ProviderDataset, task.identity["dataset_id"])
            # Recursive provider studies read the fixed prefix preceding the
            # visible window. Match Calculator's per-study input boundaries.
            floor = min(spec.get("calculation_origin") or 0 for spec in query.indicators) if query.indicators else (after or 0)
            # A callback acknowledgement covers precisely these bar values,
            # not every row changed since the initial HTTP page observation.
            accepted = {r["start"]: r["fingerprint"] for r in sub.state.get("provider_acceptance", [])}
            changed = list(db.scalars(select(ProviderBar).where(ProviderBar.dataset_id == dataset.id,
                ProviderBar.start >= floor,
                (ProviderBar.start <= before if state.get("historical") else ProviderBar.start < before),
                ProviderBar.revision > 1, ProviderBar.changed_at > state.get("observed_at", 0)).limit(LIMIT + 1)))
            if (len(changed) > LIMIT or any(not accepted.get(row.start) or
                    accepted[row.start] != fingerprint(row.payload, bool(query.indicators)) for row in changed)
                    or dataset.metadata_json.get("invalidated_at", 0) > state.get("observed_at", 0)):
                return {"type": "reset", "reason": "history_changed"}
            if dependency_origin is not None and dependency_origin < floor:
                observed = state.get("dependency_observed_at") or state.get("observed_at", 0)
                changed_at = db.scalar(select(func.max(ProviderBar.changed_at)).where(
                    ProviderBar.dataset_id == dataset.id,
                    ProviderBar.start >= dependency_origin, ProviderBar.start < floor,
                    ProviderBar.revision > 1, ProviderBar.changed_at > observed))
                if changed_at is not None:
                    page["indicator_correction"] = True
                    state["dependency_observed_at"] = changed_at
    if check:
        # Historical pages do not receive tail-bar callbacks. Preserve the HTTP
        # prefix credential and separately validate its excluded, accepted bar.
        if state.get("historical") and state.get("history_tail_revision") and (
                state["history_tail_revision"] != check.get("tail_revision")):
            return {"type": "reset", "reason": "history_changed"}
        previous = state.get("history_revision")
        # The next comparison follows the loaded tail after this delivery.
        # Advancing that boundary must not mistake normal appends for repairs.
        state["history_revision"] = (check["revision"] if state.get("historical") else
                                     check.get("next_revision", check["revision"]))
        if check.get("next_tail_revision"):
            state["history_tail_revision"] = (check["tail_revision"] if state.get("historical") else
                                             check["next_tail_revision"])
        if previous and previous != check["revision"] and not display_verified:
            return {"type": "reset", "reason": "history_changed"}
    progress = [(item.get("id"), min(item.get("cursor", 0), before or item.get("cursor", 0)),
                 item.get("status")) for item in page.get("indicator_progress", [])]
    if state.pop("initial_indicator_pending", False) and progress and all(item[2] == "complete" for item in progress):
        return {"type": "reset", "reason": "indicator_ready"}
    if "progress" in state and state["progress"] != progress:
        state["progress"] = progress
        return {"type": "reset", "reason": "indicator_progress"}
    state["progress"] = progress
    evidence = {name: page[name] for name in ("indicator_correction",) if name in page}
    evidence.update({name: state[name] for name in ("dependency_observed_at", "dependency_revision", "initial_input_revision") if state.get(name) is not None})
    if state.get("historical"):
        return {"type": "status", "status": "history_current", **evidence}
    cursor = state.get("cursor", 0)
    if cursor and page.get("recovery_floor") is not None and cursor < page["recovery_floor"]:
        return {"type": "reset", "reason": "history_gap"}
    if cursor and page.get("bars") and cursor > (page.get("latest_time") or
            page["bars"][-1].get("chart_time", page["bars"][-1]["start"])):
        return {"type": "reset", "reason": "tail_retracted", "status": page.get("status")}
    if cursor and page.get("bars") and "latest_time" not in page and cursor < page["bars"][0].get("chart_time", page["bars"][0]["start"]):
        return {"type": "reset", "reason": "history_gap"}
    page["bars"] = [bar for bar in page.get("bars", []) if bar.get("chart_time", bar["start"]) >= cursor]
    # Recursive calculations retain their complete prefix. A native plot needs
    # only values for this consumer's delivered bars, keyed by input start (not
    # the daily trading-date label). Rebuild the lists without mutating the
    # shared retained snapshot or another subscriber's delivery.
    times = {bar["start"] for bar in page["bars"]}
    if "indicators" in page:
        page["indicators"] = [{**indicator, "series": [
            {**series, "values": [value for value in series["values"] if value["time"] in times]}
            for series in indicator["series"]]} for indicator in page["indicators"]]
    if page["bars"]:
        state["cursor"] = page["bars"][-1].get("chart_time", page["bars"][-1]["start"])
        state["loaded_before"] = page["bars"][-1]["start"]
    if page.get('display_snapshot_id'):
        state['display_snapshot_id'] = page['display_snapshot_id']
    for name in ("loaded_before", "history_revision", "history_tail_revision", "initial_input_revision"):
        if name in state:
            page[name] = state[name]
    page.pop("latest_bar", None)
    if query.series_kind == "provider":
        from .provider_acceptance import BATCH, receipts
        page["provider_acceptance"] = receipts(page["bars"], bool(query.indicators), limit=BATCH)
    page.update(evidence)
    return page


def cleanup():
    with transaction() as db:
        stamp = now_ms()
        expired_sub = select(MarketStreamSubscription.id).where(
            MarketStreamSubscription.client_id == MarketStreamClient.id,
            MarketStreamSubscription.expires <= stamp).exists()
        clients = list(db.scalars(select(MarketStreamClient.id).where(
            or_(MarketStreamClient.expires <= stamp, expired_sub))
            .order_by(MarketStreamClient.id).with_for_update(skip_locked=True).limit(256)))
        expired_tasks = select(MarketStreamSubscription.task_id).where(
            MarketStreamSubscription.client_id.in_(clients),
            MarketStreamSubscription.expires <= stamp)
        # Include all references, including inactive bindings. NOT IN would also
        # let one NULL tombstone prevent every orphan task from being reclaimed.
        referenced = select(MarketStreamSubscription.id).where(
            MarketStreamSubscription.task_id == MarketStreamTask.id).exists()
        tasks = list(db.scalars(select(MarketStreamTask.id).where(or_(
            MarketStreamTask.id.in_(expired_tasks),
            (MarketStreamTask.expires <= stamp) & (MarketStreamTask.lease_until <= stamp) & ~referenced))
            .order_by(MarketStreamTask.id).with_for_update(skip_locked=True).limit(1024)))
        # Never hold a Subscription while waiting for a Task or a busy Client.
        # Recheck expiry after acquiring locks; another page may have renewed a
        # shared calculation while this cleanup was selecting candidates.
        db.execute(delete(MarketStreamSubscription).where(
            MarketStreamSubscription.client_id.in_(clients),
            MarketStreamSubscription.expires <= stamp,
            or_(MarketStreamSubscription.task_id.in_(tasks), MarketStreamSubscription.task_id.is_(None))))
        retired = list(db.scalars(select(MarketStreamTask.id).where(MarketStreamTask.id.in_(tasks),
            MarketStreamTask.expires <= stamp, MarketStreamTask.lease_until <= stamp, ~referenced)))
        from .market_notices import end_observation
        for ident in retired:
            task = db.get(MarketStreamTask, ident, options=[defer(MarketStreamTask.payload)])
            end_observation(db, task)
        db.execute(delete(MarketStreamResult).where(MarketStreamResult.task_id.in_(retired)))
        db.execute(delete(MarketStreamTask).where(MarketStreamTask.id.in_(retired)))
        subscribed = select(MarketStreamSubscription.id).where(
            MarketStreamSubscription.client_id == MarketStreamClient.id).exists()
        db.execute(delete(MarketStreamClient).where(MarketStreamClient.id.in_(clients),
            MarketStreamClient.expires <= stamp, ~subscribed))
