"""Explicit, source-backed closures. Missing observations never create a closure."""

import json
import re
from datetime import UTC, datetime
from functools import lru_cache
from typing import Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field, model_validator


class Closure(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")
    start: datetime
    end: datetime
    reason: str = Field(min_length=1, max_length=200)
    source: str = Field(min_length=1, max_length=1000)
    kind: Literal["holiday", "maintenance"] = "holiday"

    @model_validator(mode="after")
    def valid(self):
        for moment in (self.start, self.end):
            if moment.tzinfo is None or moment.second or moment.microsecond:
                raise ValueError("Calendar boundaries require a timezone and whole minute")
        if self.end <= self.start:
            raise ValueError("Calendar closure must have positive duration")
        if not self.source.startswith(("https://", "http://")):
            raise ValueError("Calendar closure requires a source URL")
        return self


class Profile(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: str = Field(min_length=1, max_length=100)
    closures: list[Closure] = Field(default_factory=list, max_length=1000)
    source_session: "SourceSession | None" = None

    @model_validator(mode="after")
    def nonoverlapping(self):
        self.closures.sort(key=lambda c: c.start)
        for previous, current in zip(self.closures, self.closures[1:]):
            if previous.end > current.start:
                raise ValueError("Calendar closures cannot overlap")
        return self


class WeeklyClosure(BaseModel):
    """Confirmed fully closed minute interiors in the source's local week."""

    model_config = ConfigDict(frozen=True, extra="forbid")
    start: int = Field(ge=0, lt=7 * 1440)
    end: int = Field(gt=0, le=7 * 1440)

    @model_validator(mode="after")
    def positive(self):
        if self.end <= self.start:
            raise ValueError("Split a closure crossing the local week boundary into two intervals")
        return self


class SourceSession(BaseModel):
    """Finite applicability proof, distinct from aggregation phase and prices."""

    model_config = ConfigDict(frozen=True, extra="forbid")
    source: str = Field(min_length=1, max_length=32)
    channel: str = Field(min_length=1, max_length=32)
    environment: str = Field(min_length=1, max_length=32)
    provider_symbol: str = Field(min_length=1, max_length=80)
    account_scope: str = Field(min_length=1, max_length=80)
    timezone: str = Field(min_length=1, max_length=80)
    reviewed_start: datetime
    reviewed_end: datetime
    evidence_url: str = Field(min_length=1, max_length=1000)
    applicability: str = Field(min_length=1, max_length=500)
    weekly_closures: tuple[WeeklyClosure, ...] = Field(default_factory=tuple, max_length=32)

    @model_validator(mode="after")
    def valid(self):
        try:
            ZoneInfo(self.timezone)
        except KeyError as error:
            raise ValueError("Unknown IANA source timezone") from error
        if (self.reviewed_start.tzinfo is None or self.reviewed_end.tzinfo is None
                or self.reviewed_end <= self.reviewed_start or any(moment.second or moment.microsecond
                    for moment in (self.reviewed_start, self.reviewed_end))):
            raise ValueError("Source session requires a finite timezone-aware review interval")
        if not self.evidence_url.startswith("https://"):
            raise ValueError("Source session requires an official HTTPS evidence URL")
        if self.account_scope != "public" and not re.fullmatch(r"sha256:[a-f0-9]{64}", self.account_scope):
            raise ValueError("Session account scope must be public or an opaque account fingerprint")
        previous = 0
        for closure in self.weekly_closures:
            if closure.start < previous:
                raise ValueError("Weekly closures must be ordered and nonoverlapping")
            previous = closure.end
        return self


Profile.model_rebuild()


@lru_cache(maxsize=64)
def _session(encoded):
    return Profile.model_validate_json(encoded).source_session


def session_from(profile: dict | None) -> SourceSession | None:
    return _session(json.dumps(profile, sort_keys=True)) if profile else None


@lru_cache(maxsize=64)
def _closures(encoded: str):
    profile = Profile.model_validate_json(encoded)
    return tuple(profile.closures)


def closures_from(profile: dict | None) -> tuple[Closure, ...]:
    return _closures(json.dumps(profile, sort_keys=True)) if profile else ()


def normalized_profile(value: dict) -> dict:
    profile = Profile.model_validate(value)
    normalized = {
        "revision": profile.revision,
        "closures": [
            {
                "start": c.start.astimezone(UTC).isoformat(),
                "end": c.end.astimezone(UTC).isoformat(),
                "reason": c.reason,
                "source": c.source,
                **({"kind": c.kind} if c.kind != "holiday" else {}),
            }
            for c in profile.closures
        ],
    }
    if profile.source_session is not None:
        normalized["source_session"] = profile.source_session.model_dump(mode="json")
    return normalized
