from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, Mapping


class NodeStatus(StrEnum):
    READY = "ready"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


class MessageRole(StrEnum):
    SYSTEM = "system"
    USER = "user"
    ASSISTANT = "assistant"
    TOOL = "tool"
    CONTEXT = "context"


@dataclass(frozen=True, slots=True)
class AgentIdentity:
    node_id: str
    name: str
    role: str
    generation: int = 0
    parent_node_id: str | None = None
    trust_score: float = 1.0

    def __post_init__(self) -> None:
        if not self.node_id.strip():
            raise ValueError("node_id must not be empty")
        if self.generation < 0:
            raise ValueError("generation must be non-negative")
        if not 0 <= self.trust_score <= 1:
            raise ValueError("trust_score must be between 0 and 1")


@dataclass(frozen=True, slots=True)
class NodeBudget:
    max_turns: int = 8
    max_tool_calls: int = 16
    max_total_tokens: int = 32_000
    timeout_seconds: float = 120.0

    def __post_init__(self) -> None:
        if self.max_turns < 1:
            raise ValueError("max_turns must be at least 1")
        if self.max_tool_calls < 0:
            raise ValueError("max_tool_calls must be non-negative")
        if self.max_total_tokens < 1:
            raise ValueError("max_total_tokens must be at least 1")
        if self.timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be positive")


@dataclass(frozen=True, slots=True)
class NodePolicy:
    max_generation: int = 3
    max_children: int = 8
    allow_direct_messages: bool = True
    allow_skip_context: bool = True

    def __post_init__(self) -> None:
        if self.max_generation < 0:
            raise ValueError("max_generation must be non-negative")
        if self.max_children < 0:
            raise ValueError("max_children must be non-negative")


@dataclass(frozen=True, slots=True)
class AgentSpec:
    identity: AgentIdentity
    instructions: str
    budget: NodeBudget = field(default_factory=NodeBudget)
    policy: NodePolicy = field(default_factory=NodePolicy)
    metadata: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.instructions.strip():
            raise ValueError("instructions must not be empty")


@dataclass(frozen=True, slots=True)
class ContextPacket:
    source_node_id: str
    content: str
    trust: float = 1.0
    edge_type: str = "message"

    def __post_init__(self) -> None:
        if not 0 <= self.trust <= 1:
            raise ValueError("context trust must be between 0 and 1")


@dataclass(frozen=True, slots=True)
class AgentInput:
    task: str
    context: tuple[ContextPacket, ...] = ()
    session_id: str | None = None
    metadata: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.task.strip():
            raise ValueError("task must not be empty")
        if self.session_id is not None and not self.session_id.strip():
            raise ValueError("session_id must not be empty")


@dataclass(frozen=True, slots=True)
class Message:
    role: MessageRole
    content: str
    name: str | None = None
    tool_call_id: str | None = None
    tool_calls: tuple[ToolCall, ...] = ()


@dataclass(frozen=True, slots=True)
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0

    def __post_init__(self) -> None:
        if self.input_tokens < 0 or self.output_tokens < 0:
            raise ValueError("token usage must be non-negative")

    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens

    def __add__(self, other: Usage) -> Usage:
        return Usage(
            input_tokens=self.input_tokens + other.input_tokens,
            output_tokens=self.output_tokens + other.output_tokens,
        )


@dataclass(frozen=True, slots=True)
class ToolCall:
    id: str
    name: str
    arguments: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class ModelResponse:
    content: str | None = None
    tool_calls: tuple[ToolCall, ...] = ()
    usage: Usage = field(default_factory=Usage)
    finish_reason: str | None = None

    def __post_init__(self) -> None:
        if self.content is None and not self.tool_calls:
            raise ValueError("model response requires content or tool calls")


@dataclass(frozen=True, slots=True)
class ToolDefinition:
    name: str
    description: str
    input_schema: Mapping[str, Any]


@dataclass(frozen=True, slots=True)
class ModelRequest:
    node_id: str
    instructions: str
    messages: tuple[Message, ...]
    tools: tuple[ToolDefinition, ...] = ()
    metadata: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class SpawnProposal:
    proposal_id: str
    parent_node_id: str
    generation: int
    role: str
    objective: str
    instructions: str
    tool_names: tuple[str, ...] = ()
    priority: float = 0.5
    budget_share: float = 0.25


@dataclass(frozen=True, slots=True)
class MessageProposal:
    proposal_id: str
    source_node_id: str
    target_node_id: str
    content: str
    priority: float = 0.5
    ttl_seconds: int = 300


@dataclass(frozen=True, slots=True)
class SkipContextProposal:
    proposal_id: str
    requester_node_id: str
    source_node_id: str
    reason: str
    context_gate: float = 0.5


@dataclass(frozen=True, slots=True)
class NodeError:
    code: str
    message: str
    retryable: bool = False


@dataclass(frozen=True, slots=True)
class AgentResult:
    node_id: str
    status: NodeStatus
    output: str | None
    usage: Usage
    events: tuple[Any, ...]
    spawn_proposals: tuple[SpawnProposal, ...] = ()
    message_proposals: tuple[MessageProposal, ...] = ()
    skip_context_proposals: tuple[SkipContextProposal, ...] = ()
    error: NodeError | None = None
