"""Authenticated browser boundary. No arbitrary URLs, source facts or phone observations."""
import asyncio
import json
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator

from . import notification_center as center
from .config import settings
from .storage import transaction


class BrowserEvent(BaseModel):
    model_config = ConfigDict(extra='forbid')
    schema_version: Literal[1] = 1
    event_id: str = Field(pattern=r'^b:[a-f0-9-]{36}$')
    profile: str = Field(pattern=r'^[a-f0-9-]{36}$')
    source_kind: Literal['workspace', 'indicator', 'history', 'capacity', 'data_center',
                         'preferences', 'market', 'connection', 'chart_shell']
    attempt_id: str = Field(min_length=1, max_length=100)
    occurred_at: int = Field(ge=0)
    code: str = Field(min_length=1, max_length=80, pattern=r'^[A-Z0-9_:.-]+$')
    severity: Literal['info', 'warning', 'error', 'critical'] = 'error'
    title: str = Field(min_length=1, max_length=160)
    message: str = Field(max_length=2000)
    context: dict = Field(default_factory=dict)
    evidence: dict = Field(default_factory=dict)
    recovery_of: str | None = Field(default=None, pattern=r'^b:[a-f0-9-]{36}$')

    @field_validator('context', 'evidence')
    @classmethod
    def bounded(cls, value):
        if len(center.canonical(value).encode()) > 12 * 1024:
            raise ValueError('通知上下文/证据过大')
        return value


class Observation(BaseModel):
    model_config = ConfigDict(extra='forbid')
    observation_id: str = Field(min_length=1, max_length=100, pattern=r'^[a-zA-Z0-9:._-]+$')
    event_id: str = Field(min_length=1, max_length=80)
    profile: str = Field(pattern=r'^[a-f0-9-]{36}$')
    kind: Literal['received', 'rendered', 'viewed', 'handled', 'sound_blocked', 'sound_suppressed',
                  'sound_expired', 'sound_reserved', 'sound_started', 'sound_failed', 'sound_unknown', 'sound_manual']
    reported_at: int | None = Field(default=None, ge=0)
    details: dict = Field(default_factory=dict)

    @field_validator('details')
    @classmethod
    def bounded(cls, value):
        if len(center.canonical(value).encode()) > 2048:
            raise ValueError('观察内容过大')
        return value


class SystemRead(BaseModel):
    model_config = ConfigDict(extra='forbid')
    profile: str = Field(pattern=r'^[a-f0-9-]{36}$')
    epoch: str = Field(min_length=1, max_length=100)
    through: int = Field(ge=0)
    incident_id: str | None = Field(default=None, max_length=100)


def router(authenticated):
    routes = APIRouter(prefix='/api/notification-center', dependencies=[Depends(authenticated)])

    @routes.get('/resolve')
    def resolve(signal: str = Query(max_length=80)):
        with transaction() as db:
            return center.resolve_signal(db, signal)

    @routes.get('/events')
    def events(before: str | None = Query(None, max_length=2000), limit: int = Query(100, ge=1, le=500),
               severity: str = '', kind: str = '', source: str = '', workspace: str = '',
               instrument: str = '', state: str = '', q: str = Query('', max_length=120),
               since: int | None = None, until: int | None = None,
               audience: Literal['all', 'system', 'alerts'] = 'all',
               incident: str = Query('', max_length=100), grouped: bool = True):
        with transaction() as db:
            return center.list_events(db, center.SUBJECT, {'severity': severity, 'kind': kind,
                'source': source, 'workspace': workspace, 'instrument': instrument, 'state': state,
                'q': q, 'since': since, 'until': until, 'audience': audience,
                'incident': incident, 'grouped': grouped}, before=before, limit=limit)

    @routes.post('/system/read')
    def read_system(value: SystemRead):
        with transaction() as db:
            return center.read_system(db, center.SUBJECT, value)

    @routes.post('/events', status_code=202)
    def intake(value: BrowserEvent):
        if not settings.notification_center_enabled:
            raise HTTPException(503, '通知接收已暂停，请保留本机待同步记录')
        with transaction() as db:
            return center.accept_browser(db, center.SUBJECT, value)

    @routes.get('/events/{event_id}')
    def detail(event_id: str):
        with transaction() as db:
            return center.detail(db, center.SUBJECT, event_id)

    @routes.get('/events/{event_id}/timeline')
    def timeline(event_id: str, before: str | None = Query(None, max_length=2000),
                 limit: int = Query(100, ge=1, le=500)):
        with transaction() as db:
            return center.timeline(db, center.SUBJECT, event_id, before=before, limit=limit)

    @routes.post('/observations')
    def observe(value: Observation):
        with transaction() as db:
            return center.observe(db, center.SUBJECT, value)

    @routes.get('/changes')
    def changes(after: str = Query(max_length=2000), limit: int = Query(100, ge=1, le=500)):
        with transaction() as db:
            return center.changes(db, center.SUBJECT, after, limit=limit)

    @routes.get('/health')
    def health():
        with transaction() as db:
            return {**center.health(db), 'display_enabled': settings.notification_center_enabled,
                    'sound_enabled': settings.notification_center_sound_enabled}

    @routes.get('/stream')
    async def stream(request: Request, after: str | None = Query(None, max_length=2000)):
        cursor = request.headers.get('last-event-id') or after
        if not cursor or len(cursor) > 2000:
            raise HTTPException(400, '请先获取历史分页基线及 after 游标')
        # Validate before sending headers; both transports use exactly this reader.
        with transaction() as db:
            center.changes(db, center.SUBJECT, cursor)

        async def messages():
            nonlocal cursor
            while not await request.is_disconnected():
                try:
                    await asyncio.to_thread(authenticated, request)
                    def read():
                        with transaction() as db:
                            return center.changes(db, center.SUBJECT, cursor)
                    result = await asyncio.to_thread(read)
                except HTTPException as error:
                    event = 'reset' if error.status_code == 409 else 'auth' if error.status_code == 401 else 'error'
                    yield f'event: {event}\ndata: {json.dumps(error.detail, ensure_ascii=False)}\n\n'
                    return
                if result['changes']:
                    cursor = result['after']
                    yield f'id: {cursor}\nevent: changes\ndata: {json.dumps(result, ensure_ascii=False)}\n\n'
                else:
                    yield ': heartbeat\n\n'
                if not result['more']:
                    await asyncio.sleep(2)
        return StreamingResponse(messages(), media_type='text/event-stream',
            headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})

    return routes
