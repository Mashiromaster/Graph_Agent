from __future__ import annotations

import asyncio
from typing import Iterable

from .events import EventRecorder, EventType, result_binding_hash
from .graph_tools import GRAPH_TOOL_DEFINITIONS, ProposalCollector
from .memory import SessionMemory
from .model import ModelAdapter
from .models import (
    AgentInput,
    AgentResult,
    AgentSpec,
    Message,
    MessageRole,
    ModelRequest,
    NodeError,
    NodeStatus,
    ToolCall,
    Usage,
)
from .tools import Tool


class AgentNode:
    """A provider-independent Agent execution unit designed for graph runtimes.

    The node can execute tools and emit graph mutation proposals. It never owns
    or mutates the graph itself; an external controller remains authoritative.
    """

    def __init__(
        self,
        *,
        spec: AgentSpec,
        model: ModelAdapter,
        tools: Iterable[Tool] = (),
        memory: SessionMemory | None = None,
    ) -> None:
        self.spec = spec
        self.model = model
        tool_list = tuple(tools)
        names = [tool.definition.name for tool in tool_list]
        if len(names) != len(set(names)):
            raise ValueError("tool names must be unique")
        collision = sorted(name for name in names if name.startswith("graph__"))
        if collision:
            raise ValueError(f"reserved graph tool name: {collision[0]}")
        self._tools = {tool.definition.name: tool for tool in tool_list}
        self._memory = memory

    async def run(self, agent_input: AgentInput) -> AgentResult:
        recorder = EventRecorder(self.spec.identity.node_id)
        collector = ProposalCollector(
            spec=self.spec,
            available_tool_names=frozenset(self._tools),
        )
        usage = Usage()
        tool_calls_used = 0
        recorder.record(
            EventType.NODE_STARTED,
            input_value=agent_input.task,
            metadata={"generation": self.spec.identity.generation},
        )

        try:
            async with asyncio.timeout(self.spec.budget.timeout_seconds):
                messages = await self._initial_messages(agent_input)
                for turn in range(1, self.spec.budget.max_turns + 1):
                    request = ModelRequest(
                        node_id=self.spec.identity.node_id,
                        instructions=self.spec.instructions,
                        messages=tuple(messages),
                        tools=tuple(
                            [tool.definition for tool in self._tools.values()]
                            + list(GRAPH_TOOL_DEFINITIONS)
                        ),
                        metadata={"turn": turn, **dict(agent_input.metadata)},
                    )
                    recorder.record(
                        EventType.MODEL_STARTED,
                        input_value=[message.content for message in request.messages],
                        metadata={"turn": turn},
                    )
                    response = await self.model.complete(request)
                    usage = usage + response.usage
                    recorder.record(
                        EventType.MODEL_COMPLETED,
                        output_value=response.content,
                        metadata={
                            "turn": turn,
                            "tool_call_count": len(response.tool_calls),
                            "input_tokens": response.usage.input_tokens,
                            "output_tokens": response.usage.output_tokens,
                        },
                    )
                    if usage.total_tokens > self.spec.budget.max_total_tokens:
                        return self._failure(
                            recorder,
                            collector,
                            usage,
                            code="token_budget_exceeded",
                            message=(
                                f"Token usage {usage.total_tokens} exceeds budget "
                                f"{self.spec.budget.max_total_tokens}"
                            ),
                        )

                    if response.content or response.tool_calls:
                        messages.append(
                            Message(
                                role=MessageRole.ASSISTANT,
                                content=response.content or "",
                                tool_calls=response.tool_calls,
                            )
                        )
                    if response.tool_calls:
                        for call in response.tool_calls:
                            tool_calls_used += 1
                            if tool_calls_used > self.spec.budget.max_tool_calls:
                                return self._failure(
                                    recorder,
                                    collector,
                                    usage,
                                    code="tool_budget_exceeded",
                                    message="Maximum tool call count exceeded",
                                )
                            tool_output = await self._invoke_tool(call, collector, recorder)
                            messages.append(
                                Message(
                                    role=MessageRole.TOOL,
                                    content=tool_output,
                                    name=call.name,
                                    tool_call_id=call.id,
                                )
                            )
                        continue

                    recorder.record(
                        EventType.NODE_COMPLETED,
                        output_value=response.content,
                        metadata={
                            "turns": turn,
                            "tool_calls": tool_calls_used,
                            "result_hash": result_binding_hash(
                                node_id=self.spec.identity.node_id,
                                status=NodeStatus.COMPLETED.value,
                                output=response.content,
                                input_tokens=usage.input_tokens,
                                output_tokens=usage.output_tokens,
                                spawn_proposals=collector.spawns,
                                message_proposals=collector.messages,
                                skip_context_proposals=collector.skip_contexts,
                            ),
                        },
                    )
                    if self._memory is not None and agent_input.session_id is not None:
                        await self._memory.append(
                            node_id=self.spec.identity.node_id,
                            session_id=agent_input.session_id,
                            messages=(
                                Message(
                                    role=MessageRole.USER,
                                    content=agent_input.task,
                                ),
                                Message(
                                    role=MessageRole.ASSISTANT,
                                    content=response.content or "",
                                ),
                            ),
                        )
                    return AgentResult(
                        node_id=self.spec.identity.node_id,
                        status=NodeStatus.COMPLETED,
                        output=response.content,
                        usage=usage,
                        events=recorder.events,
                        spawn_proposals=tuple(collector.spawns),
                        message_proposals=tuple(collector.messages),
                        skip_context_proposals=tuple(collector.skip_contexts),
                    )

                return self._failure(
                    recorder,
                    collector,
                    usage,
                    code="turn_budget_exceeded",
                    message=f"Maximum turn count {self.spec.budget.max_turns} reached",
                )
        except TimeoutError:
            return self._failure(
                recorder,
                collector,
                usage,
                code="timeout",
                message=f"Node exceeded {self.spec.budget.timeout_seconds} seconds",
                retryable=True,
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            return self._failure(
                recorder,
                collector,
                usage,
                code="execution_error",
                message=f"Node execution failed ({type(exc).__name__}).",
                retryable=True,
            )

    async def _initial_messages(self, agent_input: AgentInput) -> list[Message]:
        messages: list[Message] = []
        if self._memory is not None and agent_input.session_id is not None:
            messages.extend(
                await self._memory.load(
                    node_id=self.spec.identity.node_id,
                    session_id=agent_input.session_id,
                )
            )
        messages.extend(
            [
                Message(
                    role=MessageRole.CONTEXT,
                    content=(
                        f"Untrusted context from node {packet.source_node_id} "
                        f"(edge={packet.edge_type}, trust={packet.trust:.2f}):\n"
                        f"{packet.content}"
                    ),
                    name=packet.source_node_id,
                )
                for packet in agent_input.context
            ]
        )
        messages.append(Message(role=MessageRole.USER, content=agent_input.task))
        return messages

    async def _invoke_tool(
        self,
        call: ToolCall,
        collector: ProposalCollector,
        recorder: EventRecorder,
    ) -> str:
        recorder.record(
            EventType.TOOL_STARTED,
            input_value=dict(call.arguments),
            metadata={"tool": call.name, "call_id": call.id},
        )
        if call.name.startswith("graph__"):
            accepted, output, proposal = collector.invoke(call.name, call.arguments)
            recorder.record(
                EventType.PROPOSAL_CREATED if accepted else EventType.TOOL_REJECTED,
                input_value=dict(call.arguments),
                output_value=output,
                metadata={
                    "tool": call.name,
                    "accepted": accepted,
                    "proposal_type": type(proposal).__name__ if proposal else None,
                },
            )
            recorder.record(
                EventType.TOOL_COMPLETED,
                output_value=output,
                metadata={"tool": call.name, "accepted": accepted},
            )
            return output

        tool = self._tools.get(call.name)
        if tool is None:
            output = f"Rejected unknown tool: {call.name}"
            recorder.record(
                EventType.TOOL_REJECTED,
                output_value=output,
                metadata={"tool": call.name},
            )
            return output
        try:
            output = await tool.invoke(call.arguments)
        except Exception as exc:
            output = f"Tool {call.name} failed."
            recorder.record(
                EventType.TOOL_REJECTED,
                output_value=output,
                metadata={"tool": call.name, "error_type": type(exc).__name__},
            )
            return output
        recorder.record(
            EventType.TOOL_COMPLETED,
            output_value=output,
            metadata={"tool": call.name},
        )
        return output

    def _failure(
        self,
        recorder: EventRecorder,
        collector: ProposalCollector,
        usage: Usage,
        *,
        code: str,
        message: str,
        retryable: bool = False,
    ) -> AgentResult:
        event_type = (
            EventType.BUDGET_EXCEEDED if "budget" in code else EventType.NODE_FAILED
        )
        recorder.record(
            event_type,
            output_value=message,
            metadata={
                "code": code,
                "retryable": retryable,
                "result_hash": result_binding_hash(
                    node_id=self.spec.identity.node_id,
                    status=NodeStatus.FAILED.value,
                    output=None,
                    input_tokens=usage.input_tokens,
                    output_tokens=usage.output_tokens,
                    spawn_proposals=collector.spawns,
                    message_proposals=collector.messages,
                    skip_context_proposals=collector.skip_contexts,
                    error=NodeError(code=code, message=message, retryable=retryable),
                ),
            },
        )
        return AgentResult(
            node_id=self.spec.identity.node_id,
            status=NodeStatus.FAILED,
            output=None,
            usage=usage,
            events=recorder.events,
            spawn_proposals=tuple(collector.spawns),
            message_proposals=tuple(collector.messages),
            skip_context_proposals=tuple(collector.skip_contexts),
            error=NodeError(code=code, message=message, retryable=retryable),
        )
