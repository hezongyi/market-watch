"""Explicit, source-backed closures. Missing observations never create a closure."""

import json
from datetime import UTC, datetime
from functools import lru_cache

from pydantic import BaseModel, ConfigDict, Field, model_validator


class Closure(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")
    start: datetime
    end: datetime
    reason: str = Field(min_length=1, max_length=200)
    source: str = Field(min_length=1, max_length=1000)

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

    @model_validator(mode="after")
    def nonoverlapping(self):
        self.closures.sort(key=lambda c: c.start)
        for previous, current in zip(self.closures, self.closures[1:]):
            if previous.end > current.start:
                raise ValueError("Calendar closures cannot overlap")
        return self


@lru_cache(maxsize=64)
def _closures(encoded: str):
    profile = Profile.model_validate_json(encoded)
    return tuple(profile.closures)


def closures_from(profile: dict | None) -> tuple[Closure, ...]:
    return _closures(json.dumps(profile, sort_keys=True)) if profile else ()


def normalized_profile(value: dict) -> dict:
    profile = Profile.model_validate(value)
    return {
        "revision": profile.revision,
        "closures": [
            {
                "start": c.start.astimezone(UTC).isoformat(),
                "end": c.end.astimezone(UTC).isoformat(),
                "reason": c.reason,
                "source": c.source,
            }
            for c in profile.closures
        ],
    }
