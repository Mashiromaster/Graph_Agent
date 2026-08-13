from __future__ import annotations

import unittest

from graph_agent import (
    AgentIdentity,
    AgentInput,
    AgentNode,
    AgentSpec,
    FunctionTool,
    InMemorySessionMemory,
    ModelResponse,
    NodeBudget,
    NodePolicy,
    NodeStatus,
    ScriptedModel,
    ToolCall,
    Usage,
    verify_event_chain,
)


class AgentNodeTests(unittest.IsolatedAsyncioTestCase):
    async def test_rejects_tools_using_reserved_graph_namespace(self) -> None:
        with self.assertRaisesRegex(ValueError, "reserved graph tool"):
            AgentNode(
                spec=_spec(),
                model=ScriptedModel([ModelResponse(content="unused")]),
                tools=[
                    FunctionTool.from_callable(
                        lambda: "unsafe", name="graph__custom_mutation"
                    )
                ],
            )

    async def test_tool_loop_returns_output_and_verifiable_events(self) -> None:
        async def add(left: int, right: int) -> int:
            return left + right

        model = ScriptedModel(
            [
                ModelResponse(
                    tool_calls=(
                        ToolCall(
                            id="call-add",
                            name="add",
                            arguments={"left": 2, "right": 3},
                        ),
                    ),
                    usage=Usage(input_tokens=10, output_tokens=4),
                ),
                ModelResponse(
                    content="The answer is 5.",
                    usage=Usage(input_tokens=18, output_tokens=6),
                ),
            ]
        )
        node = AgentNode(
            spec=_spec(),
            model=model,
            tools=[FunctionTool.from_callable(add, description="Add two integers")],
        )

        result = await node.run(AgentInput(task="What is 2 + 3?"))

        self.assertEqual(NodeStatus.COMPLETED, result.status)
        self.assertEqual("The answer is 5.", result.output)
        self.assertEqual(28, result.usage.input_tokens)
        self.assertEqual(10, result.usage.output_tokens)
        self.assertTrue(verify_event_chain(result.events))
        event_types = [event.type.value for event in result.events]
        self.assertIn("tool_started", event_types)
        self.assertIn("tool_completed", event_types)
        self.assertEqual(2, len(model.requests))
        self.assertEqual("tool", model.requests[1].messages[-1].role.value)
        self.assertEqual("5", model.requests[1].messages[-1].content)
        self.assertEqual("call-add", model.requests[1].messages[-2].tool_calls[0].id)
        add_definition = next(
            tool for tool in model.requests[0].tools if tool.name == "add"
        )
        self.assertEqual(
            "integer", add_definition.input_schema["properties"]["left"]["type"]
        )

    async def test_graph_operations_are_returned_as_proposals_only(self) -> None:
        model = ScriptedModel(
            [
                ModelResponse(
                    tool_calls=(
                        ToolCall(
                            id="spawn-1",
                            name="graph__propose_spawn",
                            arguments={
                                "role": "reviewer",
                                "objective": "Review the draft",
                                "instructions": "Find concrete defects.",
                                "tool_names": [],
                                "priority": 0.8,
                                "budget_share": 0.25,
                            },
                        ),
                        ToolCall(
                            id="message-1",
                            name="graph__send_message",
                            arguments={
                                "target_node_id": "peer-7",
                                "content": "Please verify source A.",
                                "priority": 0.6,
                                "ttl_seconds": 120,
                            },
                        ),
                        ToolCall(
                            id="skip-1",
                            name="graph__request_skip_context",
                            arguments={
                                "source_node_id": "ancestor-1",
                                "reason": "Need original constraints",
                                "context_gate": 0.4,
                            },
                        ),
                    )
                ),
                ModelResponse(content="Delegation proposals prepared."),
            ]
        )
        node = AgentNode(spec=_spec(), model=model)

        result = await node.run(AgentInput(task="Delegate review work"))

        self.assertEqual(NodeStatus.COMPLETED, result.status)
        self.assertEqual(1, len(result.spawn_proposals))
        self.assertEqual("node-1", result.spawn_proposals[0].parent_node_id)
        self.assertEqual(1, result.spawn_proposals[0].generation)
        self.assertEqual(1, len(result.message_proposals))
        self.assertEqual("peer-7", result.message_proposals[0].target_node_id)
        self.assertEqual(1, len(result.skip_context_proposals))
        self.assertEqual("ancestor-1", result.skip_context_proposals[0].source_node_id)

    async def test_policy_rejects_child_requesting_unavailable_tool(self) -> None:
        model = ScriptedModel(
            [
                ModelResponse(
                    tool_calls=(
                        ToolCall(
                            id="spawn-1",
                            name="graph__propose_spawn",
                            arguments={
                                "role": "operator",
                                "objective": "Change production",
                                "instructions": "Use shell access.",
                                "tool_names": ["shell"],
                            },
                        ),
                    )
                ),
                ModelResponse(content="Request handled."),
            ]
        )
        node = AgentNode(spec=_spec(), model=model)

        result = await node.run(AgentInput(task="Create an operator"))

        self.assertEqual(NodeStatus.COMPLETED, result.status)
        self.assertEqual((), result.spawn_proposals)
        tool_message = model.requests[1].messages[-1]
        self.assertIn("rejected", tool_message.content.lower())
        self.assertIn("shell", tool_message.content)

    async def test_policy_rejects_overallocated_child_budgets(self) -> None:
        model = ScriptedModel(
            [
                ModelResponse(
                    tool_calls=(
                        ToolCall(
                            id="spawn-1",
                            name="graph__propose_spawn",
                            arguments={
                                "role": "worker",
                                "objective": "Part one",
                                "instructions": "Do part one.",
                                "budget_share": 0.7,
                            },
                        ),
                        ToolCall(
                            id="spawn-2",
                            name="graph__propose_spawn",
                            arguments={
                                "role": "worker",
                                "objective": "Part two",
                                "instructions": "Do part two.",
                                "budget_share": 0.4,
                            },
                        ),
                    )
                ),
                ModelResponse(content="Budget proposals handled."),
            ]
        )
        node = AgentNode(spec=_spec(), model=model)

        result = await node.run(AgentInput(task="Split the task"))

        self.assertEqual(1, len(result.spawn_proposals))
        self.assertIn("budget", model.requests[1].messages[-1].content.lower())

    async def test_turn_budget_returns_structured_failure(self) -> None:
        model = ScriptedModel(
            [
                ModelResponse(
                    tool_calls=(
                        ToolCall(id="one", name="ping", arguments={}),
                    )
                ),
                ModelResponse(content="This turn is outside the budget."),
            ]
        )
        node = AgentNode(
            spec=_spec(budget=NodeBudget(max_turns=1)),
            model=model,
            tools=[FunctionTool.from_callable(lambda: "pong", name="ping")],
        )

        result = await node.run(AgentInput(task="Keep going"))

        self.assertEqual(NodeStatus.FAILED, result.status)
        self.assertEqual("turn_budget_exceeded", result.error.code)
        self.assertIsNone(result.output)
        self.assertTrue(verify_event_chain(result.events))

    async def test_tool_exception_details_are_not_returned_to_model(self) -> None:
        def unsafe_tool() -> str:
            raise RuntimeError("database password is secret-123")

        model = ScriptedModel(
            [
                ModelResponse(
                    tool_calls=(ToolCall(id="unsafe-1", name="unsafe", arguments={}),)
                ),
                ModelResponse(content="The tool failed safely."),
            ]
        )
        node = AgentNode(
            spec=_spec(),
            model=model,
            tools=[FunctionTool.from_callable(unsafe_tool, name="unsafe")],
        )

        result = await node.run(AgentInput(task="Use the unsafe tool"))

        self.assertEqual(NodeStatus.COMPLETED, result.status)
        tool_message = model.requests[1].messages[-1].content
        self.assertNotIn("secret-123", tool_message)
        self.assertEqual("Tool unsafe failed.", tool_message)

    async def test_session_memory_is_reused_and_isolated_by_node(self) -> None:
        memory = InMemorySessionMemory()
        first_model = ScriptedModel([ModelResponse(content="Remembered: blue.")])
        first = AgentNode(spec=_spec(), model=first_model, memory=memory)

        await first.run(AgentInput(task="My color is blue", session_id="session-a"))

        second_model = ScriptedModel([ModelResponse(content="Your color is blue.")])
        second = AgentNode(spec=_spec(), model=second_model, memory=memory)
        result = await second.run(
            AgentInput(task="What is my color?", session_id="session-a")
        )

        self.assertEqual(NodeStatus.COMPLETED, result.status)
        self.assertEqual(
            [
                "My color is blue",
                "Remembered: blue.",
                "What is my color?",
            ],
            [message.content for message in second_model.requests[0].messages],
        )

        other_node_model = ScriptedModel([ModelResponse(content="I do not know.")])
        other_node = AgentNode(
            spec=AgentSpec(
                identity=AgentIdentity(
                    node_id="node-2", name="Other", role="generalist"
                ),
                instructions="Answer briefly.",
            ),
            model=other_node_model,
            memory=memory,
        )
        await other_node.run(
            AgentInput(task="What is my color?", session_id="session-a")
        )
        self.assertEqual(
            ["What is my color?"],
            [message.content for message in other_node_model.requests[0].messages],
        )


def _spec(*, budget: NodeBudget | None = None) -> AgentSpec:
    return AgentSpec(
        identity=AgentIdentity(
            node_id="node-1",
            name="Universal Worker",
            role="generalist",
            generation=0,
        ),
        instructions="Solve the assigned task and use tools when helpful.",
        budget=budget or NodeBudget(),
        policy=NodePolicy(max_generation=3),
    )


if __name__ == "__main__":
    unittest.main()
