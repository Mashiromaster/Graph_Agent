from __future__ import annotations

import asyncio
import json
import unittest
from dataclasses import replace
from typing import Awaitable, Callable

from graph_agent import (
    AgentIdentity,
    AgentInput,
    AgentResult,
    AgentSpec,
    BudgetSnapshot,
    ControllerPolicy,
    DecisionState,
    EdgeType,
    GraphController,
    InMemoryGraphStore,
    MessageProposal,
    NodeBudget,
    NodeError,
    NodeState,
    NodeStatus,
    RunStatus,
    SkipContextProposal,
    SpawnProposal,
    Usage,
    verify_controller_event_chain,
)
from graph_agent.events import EventRecorder, EventType, result_binding_hash


ResultCallback = Callable[[AgentInput], AgentResult | Awaitable[AgentResult]]


class FakeNode:
    def __init__(self, spec: AgentSpec, callback: ResultCallback) -> None:
        self.spec = spec
        self.callback = callback
        self.calls: list[AgentInput] = []

    async def run(self, agent_input: AgentInput) -> AgentResult:
        self.calls.append(agent_input)
        result = self.callback(agent_input)
        if asyncio.iscoroutine(result):
            return await result
        return result


class RecordingNodeFactory:
    def __init__(
        self,
        callback_for: Callable[[AgentSpec], ResultCallback] | None = None,
    ) -> None:
        self.callback_for = callback_for or (
            lambda spec: lambda _: make_result(spec.identity.node_id, output="done")
        )
        self.created: list[tuple[AgentSpec, tuple[str, ...], FakeNode]] = []

    def create(self, *, spec: AgentSpec, tool_names: tuple[str, ...]) -> FakeNode:
        node = FakeNode(spec, self.callback_for(spec))
        self.created.append((spec, tool_names, node))
        return node


class GraphControllerTests(unittest.IsolatedAsyncioTestCase):
    async def test_root_runs_once_records_usage_and_replays(self) -> None:
        root = FakeNode(
            make_spec("root", max_tokens=100),
            lambda _: make_result("root", usage=Usage(7, 3), output="root output"),
        )
        controller = GraphController(
            factory=RecordingNodeFactory(),
            policy=ControllerPolicy(max_total_tokens=150),
            store=InMemoryGraphStore(),
        )

        run_id = await controller.create_run(
            root=root,
            agent_input=AgentInput(task="Do the work"),
            allowed_tool_names=("search",),
            run_id="run-root",
        )
        snapshot = await controller.run_until_idle(run_id)

        self.assertEqual(RunStatus.SUCCEEDED, snapshot.status)
        self.assertEqual(1, len(root.calls))
        self.assertEqual(NodeState.SUCCEEDED, snapshot.nodes[0].state)
        self.assertEqual(BudgetSnapshot(150, 10, 0), snapshot.budget)
        events = controller.events(run_id)
        self.assertTrue(verify_controller_event_chain(events))
        self.assertEqual(snapshot, GraphController.replay(events))
        json.dumps(snapshot.to_dict(), allow_nan=False)

    async def test_rejects_empty_or_tampered_node_events_without_proposals(self) -> None:
        spawn = SpawnProposal(
            proposal_id="malicious-spawn",
            parent_node_id="root",
            generation=1,
            role="worker",
            objective="Escalate",
            instructions="Do unsafe work",
        )
        empty_chain_result = AgentResult(
            node_id="root",
            status=NodeStatus.COMPLETED,
            output="forged",
            usage=Usage(),
            events=(),
            spawn_proposals=(spawn,),
        )
        root = FakeNode(make_spec("root", max_tokens=40), lambda _: empty_chain_result)
        controller = GraphController(
            factory=RecordingNodeFactory(),
            policy=ControllerPolicy(max_total_tokens=40),
        )

        run_id = await controller.create_run(
            root=root, agent_input=AgentInput(task="unsafe"), run_id="run-invalid"
        )
        snapshot = await controller.run_until_idle(run_id)

        self.assertEqual(RunStatus.FAILED, snapshot.status)
        self.assertEqual(1, len(snapshot.nodes))
        self.assertEqual((), snapshot.edges)
        self.assertEqual((), snapshot.decisions)
        self.assertEqual(BudgetSnapshot(40, 40, 0), snapshot.budget)

        valid = make_result("root", output="ok")
        broken_event = replace(valid.events[-1], previous_hash="f" * 64)
        tampered = replace(valid, events=(*valid.events[:-1], broken_event))
        second = GraphController(factory=RecordingNodeFactory())
        second_id = await second.create_run(
            root=FakeNode(make_spec("root"), lambda _: tampered),
            agent_input=AgentInput(task="tampered"),
            run_id="run-tampered",
        )
        second_snapshot = await second.run_until_idle(second_id)
        self.assertEqual(RunStatus.FAILED, second_snapshot.status)

    async def test_spawn_is_deterministic_inherits_tools_budget_and_is_idempotent(
        self,
    ) -> None:
        proposal = SpawnProposal(
            proposal_id="spawn-reviewer",
            parent_node_id="root",
            generation=1,
            role="reviewer",
            objective="Review root output",
            instructions="Review independently.",
            tool_names=("search",),
            priority=0.8,
            budget_share=0.5,
        )
        root_result = make_result(
            "root",
            output="draft",
            usage=Usage(6, 4),
            spawns=(proposal,),
        )
        factory = RecordingNodeFactory()
        controller = GraphController(
            factory=factory,
            policy=ControllerPolicy(max_total_tokens=150),
        )
        run_id = await controller.create_run(
            root=FakeNode(make_spec("root", max_tokens=100), lambda _: root_result),
            agent_input=AgentInput(task="draft"),
            allowed_tool_names=("search", "calculator"),
            run_id="run-deterministic",
        )

        await controller.run_superstep(run_id)
        after_root = controller.snapshot(run_id)
        self.assertEqual(2, len(after_root.nodes))
        child = next(node for node in after_root.nodes if node.node_id != "root")
        self.assertEqual("root", child.parent_node_id)
        self.assertEqual(1, child.generation)
        self.assertEqual(("search",), child.allowed_tool_names)
        self.assertEqual(50, child.allocation_tokens)
        created_spec, created_tools, created_runner = factory.created[0]
        self.assertEqual(("search",), created_tools)
        self.assertEqual(50, created_spec.budget.max_total_tokens)
        await controller.run_superstep(run_id)
        self.assertEqual("draft", created_runner.calls[0].context[0].content)

        self.assertEqual(1, len(after_root.decisions))
        self.assertEqual(DecisionState.ACCEPTED, after_root.decisions[0].state)
        self.assertEqual(2, len(controller.snapshot(run_id).nodes))
        self.assertEqual(10, controller.snapshot(run_id).budget.committed_tokens)

        mirror = GraphController(
            factory=RecordingNodeFactory(),
            policy=ControllerPolicy(max_total_tokens=150),
        )
        mirror_id = await mirror.create_run(
            root=FakeNode(make_spec("root", max_tokens=100), lambda _: root_result),
            agent_input=AgentInput(task="draft"),
            allowed_tool_names=("search", "calculator"),
            run_id="run-deterministic",
        )
        await mirror.run_superstep(mirror_id)
        mirror_child = next(
            node for node in mirror.snapshot(mirror_id).nodes if node.node_id != "root"
        )
        self.assertEqual(child.node_id, mirror_child.node_id)

    async def test_forged_tool_and_global_node_limit_are_rejected(self) -> None:
        forged = SpawnProposal(
            proposal_id="forged",
            parent_node_id="root",
            generation=99,
            role="operator",
            objective="Escalate privileges",
            instructions="Use shell.",
            tool_names=("shell",),
            priority=0.5,
            budget_share=0.25,
        )
        controller = GraphController(
            factory=RecordingNodeFactory(),
            policy=ControllerPolicy(max_nodes=1),
        )
        run_id = await controller.create_run(
            root=FakeNode(
                make_spec("root"),
                lambda _: make_result("root", spawns=(forged,), output="done"),
            ),
            agent_input=AgentInput(task="try escalation"),
            allowed_tool_names=("search",),
            run_id="run-denied",
        )

        snapshot = await controller.run_until_idle(run_id)

        self.assertEqual(1, len(snapshot.nodes))
        self.assertEqual(DecisionState.REJECTED, snapshot.decisions[0].state)
        self.assertIn(
            snapshot.decisions[0].code,
            {"PERMISSION_ESCALATION", "NODE_LIMIT", "GENERATION_MISMATCH"},
        )

    async def test_failed_or_over_budget_result_cannot_materialize_proposals(self) -> None:
        spawn = SpawnProposal(
            proposal_id="should-not-run",
            parent_node_id="root",
            generation=1,
            role="worker",
            objective="Do not materialize",
            instructions="This proposal belongs to a failed result.",
            budget_share=0.5,
        )
        for run_id, result in (
            (
                "run-failed-result",
                make_failed_result("root", spawns=(spawn,)),
            ),
            (
                "run-over-budget",
                make_result(
                    "root",
                    usage=Usage(31, 20),
                    output="claims more than reserved",
                    spawns=(spawn,),
                ),
            ),
        ):
            with self.subTest(run_id=run_id):
                factory = RecordingNodeFactory()
                controller = GraphController(
                    factory=factory,
                    policy=ControllerPolicy(max_total_tokens=50),
                )
                created = await controller.create_run(
                    root=FakeNode(make_spec("root", max_tokens=50), lambda _: result),
                    agent_input=AgentInput(task="must fail closed"),
                    run_id=run_id,
                )

                snapshot = await controller.run_until_idle(created)

                self.assertEqual(RunStatus.FAILED, snapshot.status)
                self.assertEqual(1, len(snapshot.nodes))
                self.assertEqual((), snapshot.edges)
                self.assertEqual((), snapshot.decisions)
                self.assertEqual(BudgetSnapshot(50, 50, 0), snapshot.budget)
                self.assertEqual([], factory.created)

    async def test_nan_spawn_and_factory_failure_fail_closed(self) -> None:
        nan_spawn = SpawnProposal(
            proposal_id="nan",
            parent_node_id="root",
            generation=1,
            role="worker",
            objective="Poison the queue",
            instructions="Use NaN priority.",
            priority=float("nan"),
            budget_share=0.5,
        )
        controller = GraphController(factory=RecordingNodeFactory())
        run_id = await controller.create_run(
            root=FakeNode(
                make_spec("root"),
                lambda _: make_result("root", spawns=(nan_spawn,)),
            ),
            agent_input=AgentInput(task="validate weight"),
            run_id="run-nan",
        )

        rejected = await controller.run_until_idle(run_id)

        self.assertEqual(DecisionState.REJECTED, rejected.decisions[0].state)
        self.assertEqual("MALFORMED_PROPOSAL", rejected.decisions[0].code)
        self.assertEqual(1, len(rejected.nodes))

        class FailingFactory:
            def create(self, *, spec: AgentSpec, tool_names: tuple[str, ...]) -> FakeNode:
                raise RuntimeError("factory internal secret")

        safe_spawn = replace(nan_spawn, proposal_id="safe", priority=0.5)
        second = GraphController(factory=FailingFactory())
        second_id = await second.create_run(
            root=FakeNode(
                make_spec("root"),
                lambda _: make_result("root", spawns=(safe_spawn,)),
            ),
            agent_input=AgentInput(task="factory failure"),
            run_id="run-factory-failure",
        )

        snapshot = await second.run_until_idle(second_id)

        self.assertEqual(1, len(snapshot.nodes))
        self.assertEqual((), snapshot.edges)
        self.assertEqual(DecisionState.REJECTED, snapshot.decisions[0].state)
        self.assertEqual("FACTORY_ERROR", snapshot.decisions[0].code)
        self.assertNotIn("secret", snapshot.decisions[0].message)

    async def test_budget_reserves_commits_and_releases_unused_capacity(self) -> None:
        spawn = SpawnProposal(
            proposal_id="budget-child",
            parent_node_id="root",
            generation=1,
            role="worker",
            objective="Use a bounded slice",
            instructions="Work within budget.",
            budget_share=0.5,
        )
        factory = RecordingNodeFactory(
            lambda spec: lambda _: make_result(
                spec.identity.node_id, usage=Usage(8, 4), output="child"
            )
        )
        controller = GraphController(
            factory=factory,
            policy=ControllerPolicy(max_total_tokens=150),
        )
        run_id = await controller.create_run(
            root=FakeNode(
                make_spec("root", max_tokens=100),
                lambda _: make_result(
                    "root", usage=Usage(6, 4), output="root", spawns=(spawn,)
                ),
            ),
            agent_input=AgentInput(task="budget"),
            run_id="run-budget",
        )

        after_root = await controller.run_superstep(run_id)
        self.assertEqual(BudgetSnapshot(150, 10, 50), after_root.budget)
        final = await controller.run_until_idle(run_id)
        self.assertEqual(BudgetSnapshot(150, 22, 0), final.budget)

    async def test_superstep_executes_frontier_concurrently_and_merges_stably(
        self,
    ) -> None:
        spawns = (
            SpawnProposal(
                proposal_id="high",
                parent_node_id="root",
                generation=1,
                role="high",
                objective="High priority",
                instructions="Run high.",
                priority=0.9,
                budget_share=0.25,
            ),
            SpawnProposal(
                proposal_id="low",
                parent_node_id="root",
                generation=1,
                role="low",
                objective="Low priority",
                instructions="Run low.",
                priority=0.2,
                budget_share=0.25,
            ),
        )
        both_started = asyncio.Event()
        started: list[str] = []

        def callback_for(spec: AgentSpec) -> ResultCallback:
            async def callback(_: AgentInput) -> AgentResult:
                started.append(spec.identity.role)
                if len(started) == 2:
                    both_started.set()
                await asyncio.wait_for(both_started.wait(), timeout=1)
                return make_result(spec.identity.node_id, output=spec.identity.role)

            return callback

        controller = GraphController(
            factory=RecordingNodeFactory(callback_for),
            policy=ControllerPolicy(max_concurrency=2, max_total_tokens=500),
        )
        run_id = await controller.create_run(
            root=FakeNode(
                make_spec("root", max_tokens=200),
                lambda _: make_result("root", output="fanout", spawns=spawns),
            ),
            agent_input=AgentInput(task="fan out"),
            run_id="run-parallel",
        )
        await controller.run_superstep(run_id)

        final = await controller.run_superstep(run_id)

        self.assertEqual({"high", "low"}, set(started))
        self.assertEqual(RunStatus.SUCCEEDED, final.status)
        node_by_id = {node.node_id: node for node in final.nodes}
        settled_children = [
            event.detail["node_id"]
            for event in controller.events(run_id)
            if event.type == "execution_settled"
            and event.detail["node_id"] != "root"
        ]
        self.assertEqual(
            ["high", "low"],
            [node_by_id[node_id].role for node_id in settled_children],
        )

    async def test_dependency_edge_orders_execution_and_rejects_cycle(self) -> None:
        spawns = (
            SpawnProposal(
                proposal_id="first",
                parent_node_id="root",
                generation=1,
                role="first",
                objective="First child",
                instructions="Run first.",
                budget_share=0.25,
            ),
            SpawnProposal(
                proposal_id="second",
                parent_node_id="root",
                generation=1,
                role="second",
                objective="Second child",
                instructions="Run second.",
                budget_share=0.25,
            ),
        )
        order: list[str] = []

        def callback_for(spec: AgentSpec) -> ResultCallback:
            def callback(_: AgentInput) -> AgentResult:
                order.append(spec.identity.role)
                return make_result(spec.identity.node_id, output=spec.identity.role)

            return callback

        controller = GraphController(factory=RecordingNodeFactory(callback_for))
        run_id = await controller.create_run(
            root=FakeNode(
                make_spec("root"),
                lambda _: make_result("root", output="root", spawns=spawns),
            ),
            agent_input=AgentInput(task="dependencies"),
            run_id="run-dependencies",
        )
        after_root = await controller.run_superstep(run_id)
        first = next(node for node in after_root.nodes if node.role == "first")
        second = next(node for node in after_root.nodes if node.role == "second")

        edge = await controller.add_dependency(run_id, first.node_id, second.node_id)

        self.assertEqual(EdgeType.DEPENDS_ON, edge.type)
        with self.assertRaisesRegex(ValueError, "cycle"):
            await controller.add_dependency(run_id, second.node_id, first.node_id)
        await controller.run_superstep(run_id)
        self.assertEqual(["first"], order)
        final = await controller.run_superstep(run_id)
        self.assertEqual(["first", "second"], order)
        self.assertEqual(RunStatus.SUCCEEDED, final.status)

    async def test_failed_dependency_blocks_descendant_and_run_converges(self) -> None:
        spawns = (
            SpawnProposal(
                proposal_id="will-fail",
                parent_node_id="root",
                generation=1,
                role="failing",
                objective="Fail safely",
                instructions="Return a failure.",
                budget_share=0.25,
            ),
            SpawnProposal(
                proposal_id="blocked",
                parent_node_id="root",
                generation=1,
                role="blocked",
                objective="Wait for prerequisite",
                instructions="Must not run after failure.",
                budget_share=0.25,
            ),
        )

        def callback_for(spec: AgentSpec) -> ResultCallback:
            if spec.identity.role == "failing":
                return lambda _: make_failed_result(spec.identity.node_id)
            return lambda _: make_result(spec.identity.node_id, output="should not run")

        factory = RecordingNodeFactory(callback_for)
        controller = GraphController(factory=factory)
        run_id = await controller.create_run(
            root=FakeNode(
                make_spec("root"),
                lambda _: make_result("root", output="root", spawns=spawns),
            ),
            agent_input=AgentInput(task="blocked dependency"),
            run_id="run-blocked",
        )
        after_root = await controller.run_superstep(run_id)
        failing = next(node for node in after_root.nodes if node.role == "failing")
        blocked = next(node for node in after_root.nodes if node.role == "blocked")
        await controller.add_dependency(run_id, failing.node_id, blocked.node_id)

        final = await asyncio.wait_for(controller.run_until_idle(run_id), timeout=1)

        final_nodes = {node.role: node for node in final.nodes}
        self.assertEqual(NodeState.FAILED, final_nodes["failing"].state)
        self.assertEqual(NodeState.BLOCKED, final_nodes["blocked"].state)
        self.assertEqual(RunStatus.FAILED, final.status)
        blocked_runner = next(
            runner for spec, _, runner in factory.created if spec.identity.role == "blocked"
        )
        self.assertEqual([], blocked_runner.calls)
        self.assertEqual(0, final.pending_executions)

    async def test_checkpoint_json_roundtrip_is_strict_and_side_effect_free(self) -> None:
        root = FakeNode(
            make_spec("root"),
            lambda _: make_result("root", usage=Usage(2, 1), output="checkpoint"),
        )
        factory = RecordingNodeFactory()
        controller = GraphController(factory=factory)
        run_id = await controller.create_run(
            root=root,
            agent_input=AgentInput(task="checkpoint"),
            run_id="run-checkpoint",
        )
        live = await controller.run_until_idle(run_id)

        checkpoint = controller.checkpoint(run_id)
        replayed = GraphController.replay_checkpoint(checkpoint)

        self.assertEqual(live, replayed)
        self.assertEqual(1, len(root.calls))
        self.assertEqual([], factory.created)
        self.assertEqual(checkpoint, controller.checkpoint(run_id))
        with self.assertRaises(ValueError):
            GraphController.replay_checkpoint('{"schema_version":1,"schema_version":1}')
        with self.assertRaises(ValueError):
            GraphController.replay_checkpoint(
                '{"schema_version":1,"events":[],"state_digest":NaN}'
            )

        events = list(controller.events(run_id))
        snapshot_event = events[-1]
        impossible = snapshot_event.detail["snapshot"]
        impossible["budget"]["committed_tokens"] = impossible["budget"][
            "limit_tokens"
        ] + 1
        from graph_agent.controller_events import create_controller_event

        events[-1] = create_controller_event(
            sequence=snapshot_event.sequence,
            run_id=snapshot_event.run_id,
            event_type="snapshot",
            detail={"snapshot": impossible},
            previous_hash=snapshot_event.previous_hash,
        )
        with self.assertRaisesRegex(ValueError, "budget"):
            GraphController.replay(events)

    async def test_message_and_skip_edges_are_passive_and_replay_detects_tamper(
        self,
    ) -> None:
        spawn = SpawnProposal(
            proposal_id="child",
            parent_node_id="root",
            generation=1,
            role="child",
            objective="Respond to root",
            instructions="Send passive graph context.",
            budget_share=0.25,
        )

        def callback_for(spec: AgentSpec) -> ResultCallback:
            return lambda _: make_result(
                spec.identity.node_id,
                output="child output",
                messages=(
                    MessageProposal(
                        proposal_id="message-root",
                        source_node_id=spec.identity.node_id,
                        target_node_id="root",
                        content="passive message",
                    ),
                ),
                skips=(
                    SkipContextProposal(
                        proposal_id="skip-root",
                        requester_node_id=spec.identity.node_id,
                        source_node_id="root",
                        reason="Use original root context",
                    ),
                ),
            )

        factory = RecordingNodeFactory(callback_for)
        controller = GraphController(factory=factory)
        root = FakeNode(
            make_spec("root"),
            lambda _: make_result("root", output="root output", spawns=(spawn,)),
        )
        run_id = await controller.create_run(
            root=root,
            agent_input=AgentInput(task="passive edges"),
            run_id="run-passive",
        )

        final = await controller.run_until_idle(run_id)

        self.assertEqual(2, len(factory.created[0][2].calls) + len(root.calls))
        self.assertEqual(1, len(factory.created[0][2].calls))
        self.assertEqual(0, final.pending_executions)
        self.assertEqual(
            {EdgeType.SPAWN, EdgeType.MESSAGE, EdgeType.SKIP_CONTEXT},
            {edge.type for edge in final.edges},
        )
        self.assertEqual(final, GraphController.replay(controller.events(run_id)))
        tampered = list(controller.events(run_id))
        tampered[-1] = replace(tampered[-1], previous_hash="0" * 64)
        with self.assertRaises(ValueError):
            GraphController.replay(tampered)

    async def test_cancellation_releases_all_reservations_and_terminates_run(self) -> None:
        started = asyncio.Event()
        release = asyncio.Event()

        async def callback(_: AgentInput) -> AgentResult:
            started.set()
            await release.wait()
            return make_result("root")

        controller = GraphController(factory=RecordingNodeFactory())
        run_id = await controller.create_run(
            root=FakeNode(make_spec("root"), callback),
            agent_input=AgentInput(task="cancel safely"),
            run_id="run-cancel",
        )
        task = asyncio.create_task(controller.run_superstep(run_id))
        await asyncio.wait_for(started.wait(), timeout=1)
        task.cancel()

        with self.assertRaises(asyncio.CancelledError):
            await task
        snapshot = controller.snapshot(run_id)
        self.assertEqual(RunStatus.CANCELLED, snapshot.status)
        self.assertEqual(NodeState.CANCELLED, snapshot.nodes[0].state)
        self.assertEqual(0, snapshot.budget.reserved_tokens)
        self.assertEqual(0, snapshot.pending_executions)

    async def test_parallel_scheduler_calls_are_single_flight(self) -> None:
        started = asyncio.Event()
        release = asyncio.Event()

        async def callback(_: AgentInput) -> AgentResult:
            started.set()
            await release.wait()
            return make_result("root", usage=Usage(1, 1))

        controller = GraphController(factory=RecordingNodeFactory())
        root = FakeNode(make_spec("root"), callback)
        run_id = await controller.create_run(
            root=root,
            agent_input=AgentInput(task="single flight"),
            run_id="run-single-flight",
        )
        first = asyncio.create_task(controller.run_until_idle(run_id))
        await asyncio.wait_for(started.wait(), timeout=1)
        second = asyncio.create_task(controller.run_until_idle(run_id))
        await asyncio.sleep(0)
        event_count = len(controller.events(run_id))
        release.set()
        results = await asyncio.wait_for(asyncio.gather(first, second), timeout=1)

        self.assertEqual(1, len(root.calls))
        self.assertEqual({RunStatus.SUCCEEDED}, {value.status for value in results})
        self.assertLessEqual(len(controller.events(run_id)) - event_count, 2)

    async def test_edge_limit_applies_to_message_and_skip_edges(self) -> None:
        spawn = SpawnProposal(
            proposal_id="child",
            parent_node_id="root",
            generation=1,
            role="child",
            objective="Try passive edges",
            instructions="Stay bounded.",
            budget_share=0.5,
        )

        def callback_for(spec: AgentSpec) -> ResultCallback:
            return lambda _: make_result(
                spec.identity.node_id,
                messages=(
                    MessageProposal(
                        proposal_id="message",
                        source_node_id=spec.identity.node_id,
                        target_node_id="root",
                        content="bounded",
                    ),
                ),
                skips=(
                    SkipContextProposal(
                        proposal_id="skip",
                        requester_node_id=spec.identity.node_id,
                        source_node_id="root",
                        reason="bounded",
                    ),
                ),
            )

        controller = GraphController(
            factory=RecordingNodeFactory(callback_for),
            policy=ControllerPolicy(max_edges=1),
        )
        run_id = await controller.create_run(
            root=FakeNode(
                make_spec("root"), lambda _: make_result("root", spawns=(spawn,))
            ),
            agent_input=AgentInput(task="edge quota"),
            run_id="run-edge-quota",
        )

        snapshot = await controller.run_until_idle(run_id)

        self.assertEqual(1, len(snapshot.edges))
        self.assertEqual(
            ["EDGE_LIMIT", "EDGE_LIMIT"],
            [value.code for value in snapshot.decisions[-2:]],
        )

    async def test_malformed_ttl_usage_and_unbound_result_fail_closed(self) -> None:
        message = MessageProposal(
            proposal_id="bad-ttl",
            source_node_id="root",
            target_node_id="target",
            content="poison",
            ttl_seconds=300,
        )
        malicious_usage = object.__new__(Usage)
        object.__setattr__(malicious_usage, "input_tokens", -1)
        object.__setattr__(malicious_usage, "output_tokens", False)
        for run_id, result in (
            (
                "run-invalid-usage",
                make_result("root", usage=malicious_usage),
            ),
            (
                "run-unbound-result",
                replace(make_result("root", output="safe"), output="poison"),
            ),
        ):
            with self.subTest(run_id=run_id):
                controller = GraphController(factory=RecordingNodeFactory())
                created = await controller.create_run(
                    root=FakeNode(make_spec("root"), lambda _, value=result: value),
                    agent_input=AgentInput(task="fail closed"),
                    run_id=run_id,
                )
                snapshot = await controller.run_until_idle(created)
                self.assertEqual(RunStatus.FAILED, snapshot.status)
                self.assertEqual(BudgetSnapshot(64_000, 100, 0), snapshot.budget)

        invalid_ttl = replace(message, ttl_seconds=float("nan"))
        proposal = SpawnProposal(
            proposal_id="target",
            parent_node_id="root",
            generation=1,
            role="target",
            objective="Target",
            instructions="Target.",
            budget_share=0.5,
        )

        def ttl_callback(spec: AgentSpec) -> ResultCallback:
            return lambda _: make_result(
                spec.identity.node_id,
                messages=(
                    replace(
                        invalid_ttl,
                        source_node_id=spec.identity.node_id,
                        target_node_id="root",
                    ),
                ),
            )

        ttl_controller = GraphController(factory=RecordingNodeFactory(ttl_callback))
        ttl_run = await ttl_controller.create_run(
            root=FakeNode(
                make_spec("root"), lambda _: make_result("root", spawns=(proposal,))
            ),
            agent_input=AgentInput(task="validate ttl"),
            run_id="run-invalid-ttl",
        )
        ttl_snapshot = await ttl_controller.run_until_idle(ttl_run)
        self.assertEqual("MALFORMED_PROPOSAL", ttl_snapshot.decisions[-1].code)
        json.dumps(ttl_snapshot.to_dict(), allow_nan=False)

    async def test_terminal_run_rejects_new_dependencies(self) -> None:
        controller = GraphController(factory=RecordingNodeFactory())
        run_id = await controller.create_run(
            root=FakeNode(make_spec("root"), lambda _: make_result("root")),
            agent_input=AgentInput(task="finish"),
            run_id="run-terminal-dependency",
        )
        await controller.run_until_idle(run_id)

        with self.assertRaisesRegex(ValueError, "running run"):
            await controller.add_dependency(run_id, "root", "root")


def make_spec(node_id: str, *, max_tokens: int = 100) -> AgentSpec:
    return AgentSpec(
        identity=AgentIdentity(node_id=node_id, name=node_id.title(), role=node_id),
        instructions=f"Act as {node_id}.",
        budget=NodeBudget(max_total_tokens=max_tokens),
    )


def make_result(
    node_id: str,
    *,
    output: str = "ok",
    usage: Usage = Usage(),
    spawns: tuple[SpawnProposal, ...] = (),
    messages: tuple[MessageProposal, ...] = (),
    skips: tuple[SkipContextProposal, ...] = (),
) -> AgentResult:
    recorder = EventRecorder(node_id)
    recorder.record(EventType.NODE_STARTED, input_value="test")
    recorder.record(
        EventType.NODE_COMPLETED,
        output_value=output,
        metadata={
            "result_hash": result_binding_hash(
                node_id=node_id,
                status=NodeStatus.COMPLETED.value,
                output=output,
                input_tokens=usage.input_tokens,
                output_tokens=usage.output_tokens,
                spawn_proposals=spawns,
                message_proposals=messages,
                skip_context_proposals=skips,
            )
        },
    )
    return AgentResult(
        node_id=node_id,
        status=NodeStatus.COMPLETED,
        output=output,
        usage=usage,
        events=recorder.events,
        spawn_proposals=spawns,
        message_proposals=messages,
        skip_context_proposals=skips,
    )


def make_failed_result(
    node_id: str,
    *,
    spawns: tuple[SpawnProposal, ...] = (),
) -> AgentResult:
    recorder = EventRecorder(node_id)
    recorder.record(EventType.NODE_STARTED, input_value="test")
    error = NodeError(code="failed", message="failed")
    recorder.record(
        EventType.NODE_FAILED,
        output_value="failed",
        metadata={
            "result_hash": result_binding_hash(
                node_id=node_id,
                status=NodeStatus.FAILED.value,
                output=None,
                input_tokens=0,
                output_tokens=0,
                spawn_proposals=spawns,
                error=error,
            )
        },
    )
    return AgentResult(
        node_id=node_id,
        status=NodeStatus.FAILED,
        output=None,
        usage=Usage(),
        events=recorder.events,
        spawn_proposals=spawns,
        error=error,
    )


if __name__ == "__main__":
    unittest.main()
