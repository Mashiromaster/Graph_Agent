from __future__ import annotations

import asyncio
from collections import defaultdict
from typing import Protocol

from .models import Message


class SessionMemory(Protocol):
    async def load(self, *, node_id: str, session_id: str) -> tuple[Message, ...]: ...

    async def append(
        self,
        *,
        node_id: str,
        session_id: str,
        messages: tuple[Message, ...],
    ) -> None: ...


class InMemorySessionMemory:
    """Concurrency-safe ephemeral memory, isolated by node and session."""

    def __init__(self) -> None:
        self._messages: dict[tuple[str, str], list[Message]] = defaultdict(list)
        self._lock = asyncio.Lock()

    async def load(self, *, node_id: str, session_id: str) -> tuple[Message, ...]:
        async with self._lock:
            return tuple(self._messages[(node_id, session_id)])

    async def append(
        self,
        *,
        node_id: str,
        session_id: str,
        messages: tuple[Message, ...],
    ) -> None:
        async with self._lock:
            self._messages[(node_id, session_id)].extend(messages)
