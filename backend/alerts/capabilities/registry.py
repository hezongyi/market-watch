"""Validated, explicit capability catalog shared by adapters."""

import re
from dataclasses import dataclass
from typing import Callable, Literal

from pydantic import BaseModel

from .context import CapabilityError

SCOPES = frozenset({"market:read", "analysis:read", "charts:read", "alerts:read", "alerts:write"})


@dataclass(frozen=True)
class Capability:
    name: str
    description: str
    input_model: type[BaseModel]
    output_model: type[BaseModel]
    scopes: frozenset[str]
    effect: Literal["read", "write"]
    handler: Callable


class Registry:
    def __init__(self):
        self._items = {}
        self._frozen = False

    def register(self, capability):
        if self._frozen:
            raise ValueError("Capability registry is frozen")
        if (
            not re.fullmatch(r"[a-z][a-z0-9_]{0,79}", capability.name)
            or capability.name in self._items
        ):
            raise ValueError("Invalid or duplicate capability name")
        if (
            not isinstance(capability.description, str)
            or not capability.description
            or capability.effect not in {"read", "write"}
            or not isinstance(capability.scopes, frozenset)
            or not capability.scopes
            or not capability.scopes <= SCOPES
            or not callable(capability.handler)
        ):
            raise ValueError("Invalid capability metadata")
        writes = {scope for scope in capability.scopes if scope.endswith(":write")}
        if bool(writes) != (capability.effect == "write"):
            raise ValueError("Capability effect must match permission scopes")
        for model in (capability.input_model, capability.output_model):
            if not isinstance(model, type) or not issubclass(model, BaseModel):
                raise ValueError("Capability schemas must be Pydantic models")
            model.model_json_schema()
        if (
            capability.effect == "write"
            and "idempotency_key" not in capability.input_model.model_fields
        ):
            raise ValueError("Write capabilities require an idempotency key")
        self._items[capability.name] = capability

    def freeze(self):
        self._frozen = True
        return self

    def visible(self, scopes):
        return tuple(item for item in self._items.values() if item.scopes <= scopes)

    def resolve(self, name, scopes):
        item = self._items.get(name)
        if item is None:
            raise CapabilityError("UNSUPPORTED_CAPABILITY", "Unknown capability")
        if not item.scopes <= scopes:
            raise CapabilityError("FORBIDDEN", "Credential lacks required scope")
        return item
