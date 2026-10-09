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
    db.execute(_insert(db)(MarketStreamClient).values(id=ident, session_hash=session_hash,
        client=client, expires=now_ms() + LEASE_MS).on_conflict_do_nothing(index_elements=["id"]))
    return db.scalar(select(MarketStreamClient).where(MarketStreamClient.id == ident).with_for_update())


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
        db.execute(_insert(db)(MarketStreamTask).values(id=key, identity=identity, query=query,
            sequence=0, payload={}, fingerprint="", lease_until=0, next_at=0,
            updated_at=stamp, expires=stamp + LEASE_MS).on_conflict_do_nothing(index_elements=["id"]))
        previous_task = old.task_id if old else None
        # Replacement and last-consumer cancellation share task-row fencing
        # with publication. Consistent ordering also covers two clients that
        # concurrently exchange their old and new calculation identities.
        tasks = {task.id: task for task in db.scalars(select(MarketStreamTask).options(defer(MarketStreamTask.payload)).where(
            MarketStreamTask.id.in_(sorted({key, previous_task} - {None})))
            .order_by(MarketStreamTask.id).with_for_update())}
        task = tasks[key]
        if not old:
            old = MarketStreamSubscription(id=ident, client_id=owner.id, listener=listener)
            db.add(old)
        state = dict(state)
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
        sub.task_id = None
        db.flush()
        if task_id and not db.scalar(select(MarketStreamSubscription.id).where(
                MarketStreamSubscription.task_id == task_id,
                MarketStreamSubscription.active.is_(True), MarketStreamSubscription.expires > now_ms()).limit(1)):
            _release_demand(db, task)


def _release_demand(db, task, *, keep_revision=None):
    """Delete only this calculation's browser demand; alerts keep their owners."""
    from .storage import MarketComposite, MarketDemand, ProviderInterest

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
        db.refresh(owner, with_for_update=True)
        db.execute(update(MarketStreamClient).where(
            MarketStreamClient.id == owner.id,
            MarketStreamClient.expires <= renew_before).values(expires=deadline))
        task_ids = list(db.scalars(update(MarketStreamSubscription).where(
            MarketStreamSubscription.client_id == owner.id,
            MarketStreamSubscription.active.is_(True), MarketStreamSubscription.expires > stamp,
            MarketStreamSubscription.expires <= renew_before)
            .values(expires=deadline).returning(MarketStreamSubscription.task_id)))
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
    check = None
    if before is not None:
        query = query.model_copy(update={"track_history": True, "revision_before": before,
                                         "revision_after": after})
        if query.series_kind in ("history", "composite") and check_page.get("bars"):
            if query.series_kind == "composite" and state.get("initial_input_revision") is not None:
                from .composite_series import period
                from .storage import CompositeMinuteInput
                cutoff = period(before, query.timeframe, page["calendar"])[0]
                floor = page["origin"] if query.indicators else (after or 0)
                changed = db.scalar(select(CompositeMinuteInput.start).where(
                    CompositeMinuteInput.revision_id == page["revision_id"],
                    CompositeMinuteInput.input_revision > state["initial_input_revision"],
                    CompositeMinuteInput.input_revision <= page["input_revision"],
                    CompositeMinuteInput.start >= floor, CompositeMinuteInput.start < cutoff).limit(1))
                state["initial_input_revision"] = page["input_revision"]
                if changed is not None:
                    return {"type": "reset", "reason": "history_changed"}
            check = fixed_check(db, check_page, query, {"calendar": page["calendar"]})
        elif query.series_kind == "managed" and check_page.get("bars"):
            inst = db.get(Instrument, query.instrument)
            if query.published:
                from .managed_dataset import published_history_check
                from .storage import ChartPublication
                check = published_history_check(db, inst, db.get(ChartPublication,
                    (inst.id, query.timeframe)), check_page["bars"], query)
            else:
                source = "M15" if query.timeframe == "M30" else "D1" if query.timeframe in ("W1", "MN") else query.timeframe
                check = managed_check(db, inst, source, check_page["bars"], query)
        elif query.series_kind == "provider":
            dataset = db.get(ProviderDataset, task.identity["dataset_id"])
            changed = db.scalar(select(ProviderBar.start).where(ProviderBar.dataset_id == dataset.id,
                ProviderBar.chart_time >= (after or 0), ProviderBar.chart_time < before,
                ProviderBar.revision > 1, ProviderBar.changed_at > state.get("observed_at", 0)).limit(1))
            if changed is not None or dataset.metadata_json.get("invalidated_at", 0) > state.get("observed_at", 0):
                return {"type": "reset", "reason": "history_changed"}
    if check:
        previous = state.get("history_revision")
        # The next comparison follows the loaded tail after this delivery.
        # Advancing that boundary must not mistake normal appends for repairs.
        state["history_revision"] = (check["revision"] if state.get("historical") else
                                     check.get("next_revision", check["revision"]))
        if previous and previous != check["revision"]:
            return {"type": "reset", "reason": "history_changed"}
    progress = [(item.get("id"), min(item.get("cursor", 0), before or item.get("cursor", 0)),
                 item.get("status")) for item in page.get("indicator_progress", [])]
    if state.pop("initial_indicator_pending", False) and progress and all(item[2] == "complete" for item in progress):
        return {"type": "reset", "reason": "indicator_ready"}
    if "progress" in state and state["progress"] != progress:
        state["progress"] = progress
        return {"type": "reset", "reason": "indicator_progress"}
    state["progress"] = progress
    if state.get("historical"):
        return {"type": "status", "status": "history_current"}
    cursor = state.get("cursor", 0)
    if cursor and page.get("recovery_floor") is not None and cursor < page["recovery_floor"]:
        return {"type": "reset", "reason": "history_gap"}
    if cursor and page.get("bars") and cursor > (page.get("latest_time") or
            page["bars"][-1].get("chart_time", page["bars"][-1]["start"])):
        return {"type": "reset", "reason": "tail_retracted", "status": page.get("status")}
    if cursor and page.get("bars") and "latest_time" not in page and cursor < page["bars"][0].get("chart_time", page["bars"][0]["start"]):
        return {"type": "reset", "reason": "history_gap"}
    page["bars"] = [bar for bar in page.get("bars", []) if bar.get("chart_time", bar["start"]) >= cursor]
    if page["bars"]:
        state["cursor"] = page["bars"][-1].get("chart_time", page["bars"][-1]["start"])
        state["loaded_before"] = page["bars"][-1]["start"]
    for name in ("loaded_before", "history_revision", "initial_input_revision"):
        if name in state:
            page[name] = state[name]
    page.pop("latest_bar", None)
    return page


def cleanup():
    with transaction() as db:
        stamp = now_ms()
        db.execute(delete(MarketStreamSubscription).where(MarketStreamSubscription.expires <= stamp))
        referenced = select(MarketStreamSubscription.task_id).where(MarketStreamSubscription.active.is_(True))
        retired = select(MarketStreamTask.id).where(MarketStreamTask.expires <= stamp,
            MarketStreamTask.lease_until <= stamp, MarketStreamTask.id.not_in(referenced))
        db.execute(delete(MarketStreamResult).where(MarketStreamResult.task_id.in_(retired)))
        db.execute(delete(MarketStreamTask).where(MarketStreamTask.id.in_(retired)))
        clients = select(MarketStreamSubscription.client_id)
        db.execute(delete(MarketStreamClient).where(MarketStreamClient.expires <= stamp,
            MarketStreamClient.id.not_in(clients)))
