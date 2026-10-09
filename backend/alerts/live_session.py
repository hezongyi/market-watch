"""Finite, identity-bound session evidence for status and worker scheduling."""
import json
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from zoneinfo import ZoneInfo

from .calendar_profile import closures_from, session_from
from .config import settings


def effective_profile(identity, profile):
    return settings.oanda_live_session_profiles.get(identity.get('provider_symbol'), profile) if all(
        identity.get(key) == value for key, value in {'source': 'oanda', 'channel': 'v20', 'environment': 'practice'}.items()) else profile


def session_status(identity, profile, stamp):
    profile = effective_profile(identity, profile)
    return dict(_status(json.dumps(identity, sort_keys=True), json.dumps(profile, sort_keys=True), stamp // 60000))


@lru_cache(maxsize=512)
def _status(encoded_identity, encoded_profile, minute):
    identity, profile = json.loads(encoded_identity), json.loads(encoded_profile)
    session = session_from(profile)
    moment = datetime.fromtimestamp(minute * 60, UTC)
    unknown = {'market_session': 'unknown', 'next_session_at': None, 'calendar_verified': False}
    if not session or any(getattr(session, key) != identity.get(key) for key in (
            'source', 'channel', 'environment', 'provider_symbol', 'account_scope')):
        return unknown
    if not session.reviewed_start <= moment < moment + timedelta(minutes=1) <= session.reviewed_end:
        return unknown
    closures = closures_from(profile)
    zone = ZoneInfo(session.timezone)

    def closed(at):
        local = at.astimezone(zone)
        value = local.weekday() * 1440 + local.hour * 60 + local.minute
        return any(c.start <= at and at + timedelta(minutes=1) <= c.end for c in closures) or any(
            c.start <= value and value + 1 <= c.end for c in session.weekly_closures)

    if not closed(moment):
        return {'market_session': 'scheduled_open', 'next_session_at': None, 'calendar_verified': True}
    # Evaluate closure endpoints, including DST in the source timezone. Split
    # week-boundary closures do not fabricate a reopening at Monday midnight.
    local = moment.astimezone(zone)
    monday = local.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=local.weekday())
    candidates = [session.reviewed_end]
    candidates.extend(c.end for c in closures if c.end > moment)
    for week in (0, 1):
        candidates.extend((monday + timedelta(weeks=week, minutes=c.end)).astimezone(UTC)
                          for c in session.weekly_closures)
    boundary = next((at for at in sorted(set(candidates)) if moment < at and (
        at >= session.reviewed_end or not closed(at))), session.reviewed_end)
    return {'market_session': 'closed', 'next_session_at': int(boundary.timestamp()*1000), 'calendar_verified': True}
