from __future__ import annotations

from collections import deque
from typing import Protocol

from .models import ModelRequest, ModelResponse


class ModelAdapter(Protocol):
    async def complete(self, request: ModelRequest) -> ModelResponse:
        """Return one model turn for a framework-independent request."""


class ScriptedModel:
    """Deterministic model adapter for tests, demos, and graph simulations."""

    def __init__(self, responses: list[ModelResponse]) -> None:
        self._responses = deque(responses)
        self.requests: list[ModelRequest] = []

    async def complete(self, request: ModelRequest) -> ModelResponse:
        self.requests.append(request)
        if not self._responses:
            raise RuntimeError("ScriptedModel has no response remaining")
        return self._responses.popleft()
