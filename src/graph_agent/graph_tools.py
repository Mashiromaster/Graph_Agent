from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Mapping
from uuid import uuid4

from .models import (
    AgentSpec,
    MessageProposal,
    SkipContextProposal,
    SpawnProposal,
    ToolDefinition,
)


SPAWN_TOOL = "graph__propose_spawn"
MESSAGE_TOOL = "graph__send_message"
SKIP_CONTEXT_TOOL = "graph__request_skip_context"


GRAPH_TOOL_DEFINITIONS = (
    ToolDefinition(
        name=SPAWN_TOOL,
        description="Propose a child Agent node. The graph controller may accept or reject it.",
        input_schema={
            "type": "object",
            "properties": {
                "role": {"type": "string"},
                "objective": {"type": "string"},
                "instructions": {"type": "string"},
                "tool_names": {"type": "array", "items": {"type": "string"}},
                "priority": {"type": "number", "minimum": 0, "maximum": 1},
                "budget_share": {"type": "number", "exclusiveMinimum": 0, "maximum": 1},
            },
            "required": ["role", "objective", "instructions"],
            "additionalProperties": False,
        },
    ),
    ToolDefinition(
        name=MESSAGE_TOOL,
        description="Propose a directed message to another Agent node.",
        input_schema={
            "type": "object",
            "properties": {
                "target_node_id": {"type": "string"},
                "content": {"type": "string"},
                "priority": {"type": "number", "minimum": 0, "maximum": 1},
                "ttl_seconds": {"type": "integer", "minimum": 1},
            },
            "required": ["target_node_id", "content"],
            "additionalProperties": False,
        },
    ),
    ToolDefinition(
        name=SKIP_CONTEXT_TOOL,
        description="Request context directly from an ancestor or other permitted node.",
        input_schema={
            "type": "object",
            "properties": {
                "source_node_id": {"type": "string"},
                "reason": {"type": "string"},
                "context_gate": {"type": "number", "minimum": 0, "maximum": 1},
            },
            "required": ["source_node_id", "reason"],
            "additionalProperties": False,
        },
    ),
)


@dataclass(slots=True)
class ProposalCollector:
    spec: AgentSpec
    available_tool_names: frozenset[str]
    spawns: list[SpawnProposal] = field(default_factory=list)
    messages: list[MessageProposal] = field(default_factory=list)
    skip_contexts: list[SkipContextProposal] = field(default_factory=list)

    def invoke(self, name: str, arguments: Mapping[str, Any]) -> tuple[bool, str, Any]:
        try:
            if name == SPAWN_TOOL:
                proposal = self._spawn(arguments)
                self.spawns.append(proposal)
            elif name == MESSAGE_TOOL:
                proposal = self._message(arguments)
                self.messages.append(proposal)
            elif name == SKIP_CONTEXT_TOOL:
                proposal = self._skip_context(arguments)
                self.skip_contexts.append(proposal)
            else:
                return False, f"Rejected unknown graph operation: {name}", None
        except (KeyError, TypeError, ValueError) as exc:
            return False, f"Rejected graph proposal: {exc}", None
        return (
            True,
            json.dumps(
                {
                    "status": "proposed",
                    "proposal_id": proposal.proposal_id,
                    "note": "The external graph controller must approve this proposal.",
                },
                sort_keys=True,
            ),
            proposal,
        )

    def _spawn(self, arguments: Mapping[str, Any]) -> SpawnProposal:
        identity = self.spec.identity
        policy = self.spec.policy
        generation = identity.generation + 1
        if generation > policy.max_generation:
            raise ValueError(f"generation {generation} exceeds max {policy.max_generation}")
        if len(self.spawns) >= policy.max_children:
            raise ValueError("maximum child proposal count reached")
        raw_tools = arguments.get("tool_names", ())
        if not isinstance(raw_tools, (list, tuple)):
            raise TypeError("tool_names must be an array")
        if any(not isinstance(value, str) or not value.strip() for value in raw_tools):
            raise TypeError("tool_names must contain non-empty strings")
        requested_tools = tuple(value.strip() for value in raw_tools)
        unavailable = sorted(set(requested_tools) - self.available_tool_names)
        if unavailable:
            raise ValueError(f"unavailable tools requested: {', '.join(unavailable)}")
        priority = _unit_float(arguments.get("priority", 0.5), "priority")
        budget_share = _positive_unit_float(
            arguments.get("budget_share", 0.25), "budget_share"
        )
        allocated_budget = sum(proposal.budget_share for proposal in self.spawns)
        if allocated_budget + budget_share > 1:
            raise ValueError("child budget shares exceed the available budget")
        return SpawnProposal(
            proposal_id=str(uuid4()),
            parent_node_id=identity.node_id,
            generation=generation,
            role=_required_text(arguments, "role"),
            objective=_required_text(arguments, "objective"),
            instructions=_required_text(arguments, "instructions"),
            tool_names=requested_tools,
            priority=priority,
            budget_share=budget_share,
        )

    def _message(self, arguments: Mapping[str, Any]) -> MessageProposal:
        if not self.spec.policy.allow_direct_messages:
            raise ValueError("direct messages are disabled")
        target = _required_text(arguments, "target_node_id")
        if target == self.spec.identity.node_id:
            raise ValueError("a node cannot send a graph message to itself")
        raw_ttl = arguments.get("ttl_seconds", 300)
        if isinstance(raw_ttl, bool) or not isinstance(raw_ttl, int):
            raise TypeError("ttl_seconds must be an integer")
        ttl_seconds = raw_ttl
        if ttl_seconds < 1:
            raise ValueError("ttl_seconds must be positive")
        return MessageProposal(
            proposal_id=str(uuid4()),
            source_node_id=self.spec.identity.node_id,
            target_node_id=target,
            content=_required_text(arguments, "content"),
            priority=_unit_float(arguments.get("priority", 0.5), "priority"),
            ttl_seconds=ttl_seconds,
        )

    def _skip_context(self, arguments: Mapping[str, Any]) -> SkipContextProposal:
        if not self.spec.policy.allow_skip_context:
            raise ValueError("skip context requests are disabled")
        source = _required_text(arguments, "source_node_id")
        if source == self.spec.identity.node_id:
            raise ValueError("a node cannot request skip context from itself")
        return SkipContextProposal(
            proposal_id=str(uuid4()),
            requester_node_id=self.spec.identity.node_id,
            source_node_id=source,
            reason=_required_text(arguments, "reason"),
            context_gate=_unit_float(arguments.get("context_gate", 0.5), "context_gate"),
        )


def _required_text(arguments: Mapping[str, Any], name: str) -> str:
    raw_value = arguments[name]
    if not isinstance(raw_value, str):
        raise TypeError(f"{name} must be a string")
    value = raw_value.strip()
    if not value:
        raise ValueError(f"{name} must not be empty")
    return value


def _unit_float(value: Any, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError(f"{name} must be a number")
    number = float(value)
    if not 0 <= number <= 1:
        raise ValueError(f"{name} must be between 0 and 1")
    return number


def _positive_unit_float(value: Any, name: str) -> float:
    number = _unit_float(value, name)
    if number == 0:
        raise ValueError(f"{name} must be greater than 0")
    return number
