"""Authenticated HTTP adapter for the shared ChartAlert application."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.exc import IntegrityError

from . import chart_alert_application as application
from .chart_alert_application import Action, CapabilityQuery, Create, Edit, capabilities
from .chart_alert_geometry import GeometryQuery, geometry
from .chart_alert_service import Conflict
from .storage import transaction


def error(exc):
    status = 409 if isinstance(exc, Conflict) else 404 if isinstance(exc, LookupError) else 422
    return HTTPException(status, str(exc))


def read_operation(fn, *args, **kwargs):
    try:
        with transaction() as db:
            return fn(db, *args, **kwargs)
    except (ValueError, LookupError) as exc:
        raise error(exc) from exc


def router(authenticated):
    api = APIRouter(prefix="/api/chart-alerts", dependencies=[Depends(authenticated)])

    @api.post("/capabilities")
    def capability(body: CapabilityQuery):
        try:
            return capabilities(body)
        except ValueError as exc:
            raise error(exc) from exc

    @api.post("/geometry")
    def drawing_geometry(body: GeometryQuery):
        try:
            key = application.dataset_for(body)
            return read_operation(geometry, body, dataset_id=key)
        except ValueError as exc:
            raise error(exc) from exc

    @api.get("")
    def listing(instrument: str | None = None, status: str | None = None, search: str = ""):
        return read_operation(application.listing, instrument=instrument, status=status, search=search)

    @api.get("/events")
    def events(alert_id: str | None = None, limit: int = 100):
        return read_operation(application.events, alert_id=alert_id, limit=limit)

    @api.get("/{alert_id}")
    def read(alert_id: str):
        return read_operation(application.read, alert_id)

    @api.get("/{alert_id}/judgments")
    def judgments(alert_id: str, before: int | None = None, limit: int = 100):
        return read_operation(application.judgments, alert_id, before=before, limit=limit)

    @api.post("", status_code=201)
    def new(body: Create):
        try:
            key = application.dataset_for(body.config)
            for attempt in range(2):
                try:
                    with transaction() as db:
                        return application.new(db, body, dataset_id=key)
                except IntegrityError:
                    if attempt:
                        raise
        except ValueError as exc:
            raise error(exc) from exc

    @api.post("/{alert_id}/edit")
    def update(alert_id: str, body: Edit):
        try:
            key = application.dataset_for(body.config)
            return read_operation(application.update, alert_id, body, dataset_id=key)
        except ValueError as exc:
            raise error(exc) from exc

    @api.post("/{alert_id}/lifecycle")
    def action(alert_id: str, body: Action):
        return read_operation(application.action, alert_id, body)

    return api
