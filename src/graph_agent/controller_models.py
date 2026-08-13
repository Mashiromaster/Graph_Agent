from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import StrEnum
from typing import Any, Mapping

from .models import AgentInput, AgentSpec


class RunStatus(StrEnum):
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class NodeState(StrEnum):
    READY = "ready"
    BLOCKED = "blocked"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class ExecutionState(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class DecisionState(StrEnum):
    ACCEPTED = "accepted"
    REJECTED = "rejected"


class EdgeType(StrEnum):
    SPAWN = "spawn"
    DEPENDS_ON = "depends_on"
    MESSAGE = "message"
    SKIP_CONTEXT = "skip_context"


@dataclass(frozen=True, slots=True)
class ControllerPolicy:
    max_nodes: int = 64
    max_edges: int = 256
    max_generation: int = 4
    max_children_per_node: int = 8
    max_total_tokens: int = 64_000
    max_concurrency: int = 4
    min_trust_score: float = 0.0
    max_proposals_per_result: int = 32
    max_events_per_result: int = 512
    max_text_length: int = 16_000
    max_id_length: int = 256
    max_message_ttl_seconds: int = 86_400

    def __post_init__(self) -> None:
        integer_fields = (
            self.max_nodes,
            self.max_edges,
            self.max_generation,
            self.max_children_per_node,
            self.max_total_tokens,
            self.max_concurrency,
            self.max_proposals_per_result,
            self.max_events_per_result,
            self.max_text_length,
            self.max_id_length,
            self.max_message_ttl_seconds,
        )
        if any(type(value) is not int or value < 1 for value in integer_fields):
            raise ValueError("controller integer limits must be positive")
        if (
            isinstance(self.min_trust_score, bool)
            or not isinstance(self.min_trust_score, (int, float))
            or not 0 <= self.min_trust_score <= 1
        ):
            raise ValueError("min_trust_score must be between 0 and 1")


@dataclass(frozen=True, slots=True)
class BudgetSnapshot:
    limit_tokens: int
    committed_tokens: int
    reserved_tokens: int

    @property
    def available_tokens(self) -> int:
        return self.limit_tokens - self.committed_tokens - self.reserved_tokens


@dataclass(frozen=True, slots=True)
class NodeRecord:
    node_id: str
    name: str
    role: str
    parent_node_id: str | None
    generation: int
    priority: float
    state: NodeState
    allowed_tool_names: tuple[str, ...]
    allocation_tokens: int


@dataclass(frozen=True, slots=True)
class EdgeRecord:
    edge_id: str
    source_node_id: str
    target_node_id: str
    type: EdgeType
    priority: float = 0.5
    weight: float = 0.5
    ttl_seconds: int | None = None
    content_hash: str | None = None


@dataclass(frozen=True, slots=True)
class ExecutionRecord:
    execution_id: str
    node_id: str
    sequence: int
    state: ExecutionState
    reserved_tokens: int
    committed_tokens: int = 0
    event_chain_head: str | None = None


@dataclass(frozen=True, slots=True)
class ProposalDecision:
    proposal_id: str
    proposal_type: str
    source_node_id: str
    state: DecisionState
    code: str
    message: str
    materialized_id: str | None = None


@dataclass(frozen=True, slots=True)
class RunSnapshot:
    run_id: str
    status: RunStatus
    nodes: tuple[NodeRecord, ...]
    edges: tuple[EdgeRecord, ...]
    executions: tuple[ExecutionRecord, ...]
    decisions: tuple[ProposalDecision, ...]
    budget: BudgetSnapshot
    pending_executions: int
    superstep: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "status": self.status.value,
            "nodes": [_enum_dict(asdict(value)) for value in self.nodes],
            "edges": [_enum_dict(asdict(value)) for value in self.edges],
            "executions": [_enum_dict(asdict(value)) for value in self.executions],
            "decisions": [_enum_dict(asdict(value)) for value in self.decisions],
            "budget": asdict(self.budget),
            "pending_executions": self.pending_executions,
            "superstep": self.superstep,
        }

    @classmethod
    def from_dict(cls, value: Mapping[str, Any]) -> RunSnapshot:
        return cls(
            run_id=value["run_id"],
            status=RunStatus(value["status"]),
            nodes=tuple(
                NodeRecord(
                    **{
                        **item,
                        "state": NodeState(item["state"]),
                        "allowed_tool_names": tuple(item["allowed_tool_names"]),
                    }
                )
                for item in value["nodes"]
            ),
            edges=tuple(
                EdgeRecord(**{**item, "type": EdgeType(item["type"])})
                for item in value["edges"]
            ),
            executions=tuple(
                ExecutionRecord(
                    **{**item, "state": ExecutionState(item["state"])}
                )
                for item in value["executions"]
            ),
            decisions=tuple(
                ProposalDecision(
                    **{**item, "state": DecisionState(item["state"])}
                )
                for item in value["decisions"]
            ),
            budget=BudgetSnapshot(**value["budget"]),
            pending_executions=value["pending_executions"],
            superstep=value["superstep"],
        )


@dataclass(slots=True)
class MutableRunState:
    run_id: str
    status: RunStatus
    policy: ControllerPolicy
    nodes: dict[str, NodeRecord] = field(default_factory=dict)
    specs: dict[str, AgentSpec] = field(default_factory=dict)
    runners: dict[str, Any] = field(default_factory=dict)
    inputs: dict[str, AgentInput] = field(default_factory=dict)
    edges: list[EdgeRecord] = field(default_factory=list)
    executions: dict[str, ExecutionRecord] = field(default_factory=dict)
    decisions: list[ProposalDecision] = field(default_factory=list)
    processed_results: dict[str, tuple[ProposalDecision, ...]] = field(
        default_factory=dict
    )
    node_reservations: dict[str, int] = field(default_factory=dict)
    committed_tokens: int = 0
    reserved_tokens: int = 0
    enqueue_sequence: int = 0
    superstep: int = 0


def _enum_dict(value: dict[str, Any]) -> dict[str, Any]:
    return {
        key: item.value if isinstance(item, StrEnum) else item
        for key, item in value.items()
    }
