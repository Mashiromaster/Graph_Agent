from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass
from enum import StrEnum
from typing import Any, Iterable, Mapping


class EventType(StrEnum):
    NODE_STARTED = "node_started"
    MODEL_STARTED = "model_started"
    MODEL_COMPLETED = "model_completed"
    TOOL_STARTED = "tool_started"
    TOOL_COMPLETED = "tool_completed"
    TOOL_REJECTED = "tool_rejected"
    PROPOSAL_CREATED = "proposal_created"
    BUDGET_EXCEEDED = "budget_exceeded"
    NODE_COMPLETED = "node_completed"
    NODE_FAILED = "node_failed"


GENESIS_HASH = "0" * 64


@dataclass(frozen=True, slots=True)
class RunEvent:
    sequence: int
    timestamp: float
    node_id: str
    type: EventType
    input_hash: str
    output_hash: str
    metadata_json: str
    previous_hash: str
    event_hash: str

    @property
    def metadata(self) -> Mapping[str, Any]:
        return json.loads(self.metadata_json)


class EventRecorder:
    def __init__(self, node_id: str) -> None:
        self._node_id = node_id
        self._events: list[RunEvent] = []

    @property
    def events(self) -> tuple[RunEvent, ...]:
        return tuple(self._events)

    def record(
        self,
        event_type: EventType,
        *,
        input_value: Any = None,
        output_value: Any = None,
        metadata: Mapping[str, Any] | None = None,
    ) -> RunEvent:
        sequence = len(self._events)
        timestamp = time.time()
        previous_hash = self._events[-1].event_hash if self._events else GENESIS_HASH
        input_hash = _value_hash(input_value)
        output_hash = _value_hash(output_value)
        metadata_json = json.dumps(
            metadata or {}, sort_keys=True, separators=(",", ":"), default=str
        )
        event_hash = _event_hash(
            sequence=sequence,
            timestamp=timestamp,
            node_id=self._node_id,
            event_type=event_type,
            input_hash=input_hash,
            output_hash=output_hash,
            metadata_json=metadata_json,
            previous_hash=previous_hash,
        )
        event = RunEvent(
            sequence=sequence,
            timestamp=timestamp,
            node_id=self._node_id,
            type=event_type,
            input_hash=input_hash,
            output_hash=output_hash,
            metadata_json=metadata_json,
            previous_hash=previous_hash,
            event_hash=event_hash,
        )
        self._events.append(event)
        return event


def verify_event_chain(events: Iterable[RunEvent]) -> bool:
    previous_hash = GENESIS_HASH
    for expected_sequence, event in enumerate(events):
        if event.sequence != expected_sequence or event.previous_hash != previous_hash:
            return False
        recalculated = _event_hash(
            sequence=event.sequence,
            timestamp=event.timestamp,
            node_id=event.node_id,
            event_type=event.type,
            input_hash=event.input_hash,
            output_hash=event.output_hash,
            metadata_json=event.metadata_json,
            previous_hash=event.previous_hash,
        )
        if recalculated != event.event_hash:
            return False
        previous_hash = event.event_hash
    return True


def _value_hash(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, default=str, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _event_hash(
    *,
    sequence: int,
    timestamp: float,
    node_id: str,
    event_type: EventType,
    input_hash: str,
    output_hash: str,
    metadata_json: str,
    previous_hash: str,
) -> str:
    value = "|".join(
        (
            str(sequence),
            repr(timestamp),
            node_id,
            event_type.value,
            input_hash,
            output_hash,
            metadata_json,
            previous_hash,
        )
    )
    return hashlib.sha256(value.encode("utf-8")).hexdigest()
