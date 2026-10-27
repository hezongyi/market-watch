"""MCP adapter for ChartAlert; writes share AgentOperation's transaction."""

from typing import Literal

from pydantic import Field

from .. import chart_alert_application as application
from ..chart_alert_service import AlertConfig, Conflict
from ..storage import transaction
from .context import CapabilityError
from .models import Input, Record, WriteInput
from .registry import Capability


class ListAlerts(Input):
    instrument: str | None = Field(default=None, max_length=64)
    status: Literal["active", "paused", "completed", "expired", "archived"] | None = None
    search: str = Field(default="", max_length=100)


class GetAlert(Input):
    alert_id: str = Field(min_length=1, max_length=36)


class Events(Input):
    alert_id: str | None = Field(default=None, max_length=36)
    limit: int = Field(default=100, ge=1, le=500)


class CreateAlert(WriteInput):
    request_id: str = Field(min_length=1, max_length=100)
    config: AlertConfig


class EditAlert(WriteInput):
    alert_id: str = Field(min_length=1, max_length=36)
    version: int = Field(ge=1)
    config: AlertConfig


class Lifecycle(WriteInput):
    alert_id: str = Field(min_length=1, max_length=36)
    version: int = Field(ge=1)
    control_revision: int = Field(ge=1)
    request_id: str = Field(min_length=1, max_length=100)
    action: Literal["pause", "resume", "restart", "rebaseline", "archive", "drawing_deleted"]


class Items(Record):
    items: list[dict]


class Alert(Record):
    id: str
    version: int
    control_revision: int
    config: dict
    status: str


def invoke(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except Conflict as exc:
        raise CapabilityError("BUSINESS_CONFLICT", str(exc)) from exc
    except LookupError as exc:
        raise CapabilityError("DATA_UNAVAILABLE", str(exc)) from exc
    except ValueError as exc:
        raise CapabilityError("INVALID_ARGUMENT", str(exc)) from exc


def listing(ctx, query):
    with transaction() as db:
        return {"items": invoke(application.listing, db, **query.model_dump())}


def read(ctx, query):
    with transaction() as db:
        return invoke(application.read, db, query.alert_id)


def events(ctx, query):
    with transaction() as db:
        return {"items": invoke(application.events, db, **query.model_dump())}


def create(ctx, query, db):
    invoke(application.require_executable_source, query.config)
    key = invoke(application.dataset_for, query.config)
    return invoke(application.new, db, application.Create(
        request_id=query.request_id, config=query.config), dataset_id=key)


def edit(ctx, query, db):
    invoke(application.require_executable_source, query.config)
    key = invoke(application.dataset_for, query.config)
    return invoke(application.update, db, query.alert_id, application.Edit(
        version=query.version, config=query.config), dataset_id=key)


def lifecycle(ctx, query, db):
    return invoke(application.action, db, query.alert_id, application.Action(
        **query.model_dump(exclude={"idempotency_key", "alert_id"})))


def register_chart_alerts(registry):
    entries = [
        ("chart_alerts_list", "List ChartAlerts shared with the web app, up to 500; archived requires explicit status.", ListAlerts, Items, "read", listing),
        ("chart_alerts_get", "Read a ChartAlert with its current config, version and control revision.", GetAlert, Alert, "read", read),
        ("chart_alerts_create", "Create a ChartAlert with the web AlertConfig contract. Stable request_id deduplicates the logical rule; idempotency_key deduplicates this agent operation. Association is optional.", CreateAlert, Alert, "write", create),
        ("chart_alerts_edit", "Edit a ChartAlert using its current version; same validation and binding as web. Stale versions conflict.", EditAlert, Alert, "write", edit),
        ("chart_alerts_lifecycle", "Pause/resume/restart/rebaseline/archive a ChartAlert. Requires current version, control_revision and stable request_id; does not acknowledge historical events.", Lifecycle, Alert, "write", lifecycle),
        ("chart_alerts_events", "Read ChartAlert events and independent notification/delivery state, up to 500.", Events, Items, "read", events),
    ]
    for name, description, inp, out, effect, handler in entries:
        registry.register(Capability(name, description, inp, out,
            frozenset({"alerts:" + effect}), effect, handler))
