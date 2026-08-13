from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any, Iterable, Mapping


CONTROLLER_GENESIS_HASH = "0" * 64


@dataclass(frozen=True, slots=True)
class ControllerEvent:
    sequence: int
    run_id: str
    type: str
    detail_json: str
    previous_hash: str
    event_hash: str
    schema_version: int = 1

    @property
    def detail(self) -> Mapping[str, Any]:
        return _strict_json_loads(self.detail_json)


def create_controller_event(
    *,
    sequence: int,
    run_id: str,
    event_type: str,
    detail: Mapping[str, Any],
    previous_hash: str,
) -> ControllerEvent:
    detail_json = canonical_json(detail)
    event_hash = _event_hash(
        sequence=sequence,
        run_id=run_id,
        event_type=event_type,
        detail_json=detail_json,
        previous_hash=previous_hash,
        schema_version=1,
    )
    return ControllerEvent(
        sequence=sequence,
        run_id=run_id,
        type=event_type,
        detail_json=detail_json,
        previous_hash=previous_hash,
        event_hash=event_hash,
    )


def verify_controller_event_chain(events: Iterable[ControllerEvent]) -> bool:
    previous_hash = CONTROLLER_GENESIS_HASH
    run_id: str | None = None
    found = False
    try:
        for sequence, event in enumerate(events):
            found = True
            if run_id is None:
                run_id = event.run_id
            if (
                event.schema_version != 1
                or event.run_id != run_id
                or event.sequence != sequence
                or event.previous_hash != previous_hash
                or event.event_hash
                != _event_hash(
                    sequence=event.sequence,
                    run_id=event.run_id,
                    event_type=event.type,
                    detail_json=event.detail_json,
                    previous_hash=event.previous_hash,
                    schema_version=event.schema_version,
                )
            ):
                return False
            _strict_json_loads(event.detail_json)
            previous_hash = event.event_hash
    except (AttributeError, TypeError, ValueError, json.JSONDecodeError):
        return False
    return found


def canonical_json(value: Mapping[str, Any]) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )


def _event_hash(
    *,
    sequence: int,
    run_id: str,
    event_type: str,
    detail_json: str,
    previous_hash: str,
    schema_version: int,
) -> str:
    value = canonical_json(
        {
            "detail": _strict_json_loads(detail_json),
            "previous_hash": previous_hash,
            "run_id": run_id,
            "schema_version": schema_version,
            "sequence": sequence,
            "type": event_type,
        }
    )
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _strict_json_loads(value: str) -> Any:
    def reject_constant(constant: str) -> None:
        raise ValueError(f"invalid JSON constant: {constant}")

    def reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, item in pairs:
            if key in result:
                raise ValueError(f"duplicate JSON key: {key}")
            result[key] = item
        return result

    return json.loads(
        value,
        parse_constant=reject_constant,
        object_pairs_hook=reject_duplicates,
    )
