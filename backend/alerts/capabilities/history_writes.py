"""Explicitly authorized managed-history writes, reusing browser commands."""

import hashlib
import json
from typing import Literal

from pydantic import Field

from .. import history_commands as commands
from ..history_api import AggregationRequest, DatasetRequest, MaintenanceRequest
from .context import CapabilityError
from .models import Record, WriteInput
from .registry import Capability


class CreateManaged(WriteInput):
    dataset: DatasetRequest
    maintenance: MaintenanceRequest


class DatasetWrite(WriteInput):
    dataset_id: str = Field(min_length=64, max_length=64)


class ReclaimDataset(DatasetWrite):
    expected_review_revision: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")


class ConfigureMaintenance(DatasetWrite):
    maintenance: MaintenanceRequest


class ControlMaintenance(DatasetWrite):
    action: Literal["pause", "resume", "archive", "unarchive"]


class SubmitTask(DatasetWrite):
    kind: Literal["update", "backfill", "recheck"] = "update"
    start: int | None = Field(default=None, ge=0, strict=True)
    end: int | None = Field(default=None, gt=0, strict=True)


class ControlTask(WriteInput):
    version_id: str = Field(min_length=1, max_length=36)
    action: Literal["pause", "resume", "retry", "cancel"]


class ChangeAggregation(DatasetWrite):
    aggregation: AggregationRequest


class RequestArtifacts(WriteInput):
    version_id: str = Field(min_length=1, max_length=36)
    timeframes: list[Literal["M1", "M5", "M15", "M30", "H1", "H4", "D1", "W1", "MN"]] = Field(min_length=1, max_length=9)


def request_id(ctx, body, action):
    # Namespaces span credentials of the same agent, matching AgentOperation.
    identity = json.dumps([ctx.agent_id, action, body.idempotency_key], separators=(",", ":"))
    return "agent:" + hashlib.sha256(identity.encode()).hexdigest()


def invoke(function, *args, **kwargs):
    try:
        return function(*args, **kwargs)
    except (ValueError, KeyError) as error:
        raise CapabilityError("DATA_UNAVAILABLE", str(error)) from None


def create(ctx, body, db):
    return invoke(commands.create_managed, db, {"dataset": body.dataset.model_dump(),
        "maintenance": body.maintenance.model_dump(), "request_id": request_id(ctx, body, "create")})


def submit(ctx, body, db):
    return invoke(commands.submit_task, db, body.dataset_id, {"kind": body.kind,
        "start": body.start, "end": body.end, "request_id": request_id(ctx, body, "task")})


def reclaim(ctx, body, db):
    from ..history_retention import ReclamationConflict
    from ..history_retention import reclaim as command

    try:
        return command(db, body.dataset_id, request_id(ctx, body, "reclaim"),
                       expected_review_revision=body.expected_review_revision)
    except ReclamationConflict as error:
        raise CapabilityError("RECLAMATION_CHANGED", str(error), context={"references": error.report}) from None
    except ValueError as error:
        raise CapabilityError("DATA_UNAVAILABLE", str(error)) from None


def register_history_writes(registry):
    entries = [
        ("history_create_dataset", "Create managed Dukascopy/OANDA Bid M1 history and maintenance task from explicit source/symbol/calendar fields. No live stream demand; existing references/identities are preserved.", CreateManaged, create),
        ("history_configure_maintenance", "Configure daily or one-off managed-history plan. Raw M1 remains source-specific; scheduling does not retarget a fixed composite or backtest.", ConfigureMaintenance,
         lambda ctx, body, db: invoke(commands.configure_maintenance, db, body.dataset_id, body.maintenance)),
        ("history_control_maintenance", "Pause/resume schedule or archive/unarchive managed dataset. Existing published versions and active composite demand remain available.", ControlMaintenance,
         lambda ctx, body, db: invoke(commands.control_maintenance, db, body.dataset_id, body.action)),
        ("history_submit_task", "Queue finite update/backfill/recheck over explicit ended UTC minute ranges; update default cutoff is fixed at submission. No supplier I/O during the command.", SubmitTask, submit),
        ("history_control_task", "Pause/resume/retry/cancel a managed-history task; interrupted writers retain checkpoints and ownership fencing.", ControlTask,
         lambda ctx, body, db: invoke(commands.control_task, db, body.version_id, body.action)),
        ("history_change_aggregation", "Create a separate NY17/UTC0 dataset/version derived from unchanged source M1. Original fixed versions, backtests and running composites do not change.", ChangeAggregation,
         lambda ctx, body, db: invoke(commands.change_aggregation, db, body.dataset_id, body.aggregation)),
        ("history_request_artifacts", "Queue specified period artifacts from a published immutable M1 version. Pending periods stay unavailable until publication; no download or live demand.", RequestArtifacts,
         lambda ctx, body, db: invoke(commands.request_artifacts, db, body.version_id, body.timeframes)),
        ("history_reclaim_dataset", "Physically reclaim prices only from a paused archived managed dataset with no surviving business references or active tasks. Optionally pins reviewed impact revision; conflicts return current impact. Rechecks under locks; preserves shared reachable blocks and evidence. Explicit destructive operation.", ReclaimDataset, reclaim),
    ]
    for name, description, model, handler in entries:
        registry.register(Capability(name, description, model, Record,
            frozenset({"market:read", "market:write"}), "write", handler))
