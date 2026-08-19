from __future__ import annotations

import asyncio
import hashlib
import json
import math
from dataclasses import asdict, replace
from typing import Any, Iterable, Mapping, Protocol

from .controller_events import (
    CONTROLLER_GENESIS_HASH,
    ControllerEvent,
    canonical_json,
    create_controller_event,
    verify_controller_event_chain,
)
from .controller_models import (
    BudgetSnapshot,
    ControllerPolicy,
    DecisionState,
    EdgeRecord,
    EdgeType,
    ExecutionRecord,
    ExecutionState,
    MutableRunState,
    NodeRecord,
    NodeState,
    ProposalDecision,
    RunSnapshot,
    RunStatus,
)
from .events import EventType, RunEvent, result_binding_hash, verify_event_chain
from .models import (
    AgentIdentity,
    AgentInput,
    AgentResult,
    AgentSpec,
    ContextPacket,
    MessageProposal,
    NodeBudget,
    NodeError,
    NodeStatus,
    SkipContextProposal,
    SpawnProposal,
    Usage,
)


class NodeRunner(Protocol):
    spec: AgentSpec

    async def run(self, agent_input: AgentInput) -> AgentResult: ...


class NodeFactory(Protocol):
    def create(self, *, spec: AgentSpec, tool_names: tuple[str, ...]) -> NodeRunner: ...


class _RunnerCancelledError(Exception):
    """A node cancelled itself without cancelling the controller task."""


class InMemoryGraphStore:
    """Single-process store. The controller remains the only writer."""

    def __init__(self) -> None:
        self.runs: dict[str, MutableRunState] = {}
        self.run_events: dict[str, list[ControllerEvent]] = {}


class GraphController:
    def __init__(
        self,
        *,
        factory: NodeFactory,
        policy: ControllerPolicy | None = None,
        store: InMemoryGraphStore | None = None,
    ) -> None:
        self._factory = factory
        self._policy = policy or ControllerPolicy()
        self._store = store or InMemoryGraphStore()
        self._lock = asyncio.Lock()
        self._run_locks: dict[str, asyncio.Lock] = {
            run_id: asyncio.Lock() for run_id in self._store.runs
        }

    async def create_run(
        self,
        *,
        root: NodeRunner,
        agent_input: AgentInput,
        allowed_tool_names: Iterable[str] = (),
        priority: float = 1.0,
        run_id: str,
    ) -> str:
        async with self._lock:
            if (
                not isinstance(run_id, str)
                or not run_id.strip()
                or run_id in self._store.runs
            ):
                raise ValueError("run_id must be unique and non-empty")
            _validate_text(run_id, self._policy.max_id_length)
            _validate_priority(priority)
            spec = root.spec
            _validate_text(spec.identity.node_id, self._policy.max_id_length)
            _validate_text(spec.identity.name, self._policy.max_text_length)
            _validate_text(spec.identity.role, self._policy.max_text_length)
            _validate_unit(spec.identity.trust_score)
            if (
                type(spec.budget.max_total_tokens) is not int
                or spec.budget.max_total_tokens < 1
            ):
                raise ValueError("root token budget must be a positive integer")
            if spec.identity.generation != 0 or spec.identity.parent_node_id is not None:
                raise ValueError("root identity must have generation 0 and no parent")
            if spec.identity.trust_score < self._policy.min_trust_score:
                raise ValueError("root trust score is below controller policy")
            allocation = min(spec.budget.max_total_tokens, self._policy.max_total_tokens)
            node = NodeRecord(
                node_id=spec.identity.node_id,
                name=spec.identity.name,
                role=spec.identity.role,
                parent_node_id=None,
                generation=0,
                priority=priority,
                state=NodeState.READY,
                allowed_tool_names=_normalize_tools(
                    allowed_tool_names, max_length=self._policy.max_id_length
                ),
                allocation_tokens=allocation,
            )
            state = MutableRunState(
                run_id=run_id,
                status=RunStatus.RUNNING,
                policy=self._policy,
                nodes={node.node_id: node},
                specs={node.node_id: spec},
                runners={node.node_id: root},
                inputs={node.node_id: agent_input},
                node_reservations={node.node_id: allocation},
                reserved_tokens=allocation,
            )
            self._store.runs[run_id] = state
            self._store.run_events[run_id] = []
            self._run_locks[run_id] = asyncio.Lock()
            self._append_event(run_id, "run_created", {})
            self._append_snapshot_event(state)
            return run_id

    async def run_superstep(self, run_id: str) -> RunSnapshot:
        try:
            run_lock = self._run_locks[run_id]
        except KeyError:
            self._state(run_id)
            raise
        async with run_lock:
            return await self._run_superstep_once(run_id)

    async def _run_superstep_once(self, run_id: str) -> RunSnapshot:
        async with self._lock:
            state = self._state(run_id)
            if state.status is not RunStatus.RUNNING:
                return self._snapshot(state)
            frontier = sorted(
                (
                    node
                    for node in state.nodes.values()
                    if node.state is NodeState.READY
                    and self._dependencies_satisfied(state, node.node_id)
                ),
                key=lambda item: (-item.priority, item.node_id),
            )
            if not frontier:
                self._block_failed_dependents(state)
                self._settle_run(state)
                self._append_snapshot_event(state)
                return self._snapshot(state)
            claims: list[tuple[NodeRecord, ExecutionRecord, NodeRunner, AgentInput]] = []
            for node in frontier:
                reservation = state.node_reservations.pop(node.node_id, 0)
                if reservation < 1:
                    state.nodes[node.node_id] = replace(node, state=NodeState.FAILED)
                    continue
                execution_id = _deterministic_id(
                    "exec", run_id, node.node_id, str(state.enqueue_sequence)
                )
                execution = ExecutionRecord(
                    execution_id=execution_id,
                    node_id=node.node_id,
                    sequence=state.enqueue_sequence,
                    state=ExecutionState.RUNNING,
                    reserved_tokens=reservation,
                )
                state.enqueue_sequence += 1
                state.executions[execution_id] = execution
                running_node = replace(node, state=NodeState.RUNNING)
                state.nodes[node.node_id] = running_node
                claims.append(
                    (
                        running_node,
                        execution,
                        state.runners[node.node_id],
                        state.inputs[node.node_id],
                    )
                )
            state.superstep += 1

            max_concurrency = state.policy.max_concurrency

        semaphore = asyncio.Semaphore(max_concurrency)

        async def execute(
            claim: tuple[NodeRecord, ExecutionRecord, NodeRunner, AgentInput],
        ) -> tuple[NodeRecord, ExecutionRecord, AgentResult | Exception]:
            node, execution, runner, agent_input = claim
            async with semaphore:
                try:
                    result = await runner.run(agent_input)
                except asyncio.CancelledError:
                    result = _RunnerCancelledError("node execution was cancelled")
                except Exception as exc:
                    result = exc
                return node, execution, result

        try:
            raw = await asyncio.gather(*(execute(claim) for claim in claims))
            raw.sort(key=lambda item: item[1].sequence)
            async with self._lock:
                for node, execution, result in raw:
                    if isinstance(result, Exception):
                        self._settle_exception(state, node, execution, result)
                    else:
                        await self._ingest_locked(state, execution, result)
                self._settle_run(state)
                self._append_snapshot_event(state)
                return self._snapshot(state)
        except asyncio.CancelledError:
            async with self._lock:
                self._cancel_claims(state, claims)
                self._append_snapshot_event(state)
            raise

    async def run_until_idle(self, run_id: str) -> RunSnapshot:
        while True:
            snapshot = await self.run_superstep(run_id)
            if snapshot.pending_executions == 0:
                return snapshot

    async def add_dependency(
        self, run_id: str, source_node_id: str, target_node_id: str
    ) -> EdgeRecord:
        try:
            run_lock = self._run_locks[run_id]
        except KeyError:
            self._state(run_id)
            raise
        async with run_lock, self._lock:
            state = self._state(run_id)
            if state.status is not RunStatus.RUNNING:
                raise ValueError("dependencies can only be added to a running run")
            if source_node_id == target_node_id:
                raise ValueError("dependency self-edge is not allowed")
            if source_node_id not in state.nodes or target_node_id not in state.nodes:
                raise ValueError("dependency endpoint not found")
            if state.nodes[target_node_id].state is not NodeState.READY:
                raise ValueError("dependency target must still be ready")
            if len(state.edges) >= state.policy.max_edges:
                raise ValueError("controller edge limit reached")
            if any(
                edge.type is EdgeType.DEPENDS_ON
                and edge.source_node_id == source_node_id
                and edge.target_node_id == target_node_id
                for edge in state.edges
            ):
                raise ValueError("duplicate dependency edge")
            if _reachable(state, target_node_id, source_node_id):
                raise ValueError("dependency edge would create a cycle")
            edge = EdgeRecord(
                edge_id=_deterministic_id(
                    "dependency", state.run_id, source_node_id, target_node_id
                ),
                source_node_id=source_node_id,
                target_node_id=target_node_id,
                type=EdgeType.DEPENDS_ON,
            )
            state.edges.append(edge)
            self._append_event(
                run_id,
                "dependency_added",
                {"source_node_id": source_node_id, "target_node_id": target_node_id},
            )
            self._append_snapshot_event(state)
            return edge

    def snapshot(self, run_id: str) -> RunSnapshot:
        return self._snapshot(self._state(run_id))

    def events(self, run_id: str) -> tuple[ControllerEvent, ...]:
        self._state(run_id)
        return tuple(self._store.run_events[run_id])

    def checkpoint(self, run_id: str) -> str:
        snapshot = self.snapshot(run_id)
        events = self.events(run_id)
        snapshot_json = canonical_json(snapshot.to_dict())
        return canonical_json(
            {
                "chain_head": events[-1].event_hash,
                "event_count": len(events),
                "events": [asdict(event) for event in events],
                "run_id": run_id,
                "schema_version": 1,
                "state_digest": hashlib.sha256(
                    snapshot_json.encode("utf-8")
                ).hexdigest(),
            }
        )

    @staticmethod
    def replay_checkpoint(checkpoint_json: str) -> RunSnapshot:
        if not isinstance(checkpoint_json, str) or len(checkpoint_json) > 5_000_000:
            raise ValueError("checkpoint must be bounded JSON text")
        try:
            value = json.loads(
                checkpoint_json,
                parse_constant=lambda constant: (_raise_invalid_constant(constant)),
                object_pairs_hook=_reject_duplicate_keys,
            )
            if not isinstance(value, dict) or set(value) != {
                "chain_head",
                "event_count",
                "events",
                "run_id",
                "schema_version",
                "state_digest",
            }:
                raise ValueError("checkpoint schema is invalid")
            if value["schema_version"] != 1 or not isinstance(value["events"], list):
                raise ValueError("checkpoint version is unsupported")
            events = tuple(ControllerEvent(**event) for event in value["events"])
            if (
                value["event_count"] != len(events)
                or not events
                or value["chain_head"] != events[-1].event_hash
                or value["run_id"] != events[0].run_id
            ):
                raise ValueError("checkpoint header does not match event stream")
            snapshot = GraphController.replay(events)
            digest = hashlib.sha256(
                canonical_json(snapshot.to_dict()).encode("utf-8")
            ).hexdigest()
            if digest != value["state_digest"]:
                raise ValueError("checkpoint state digest mismatch")
            return snapshot
        except (KeyError, TypeError, json.JSONDecodeError) as exc:
            raise ValueError("checkpoint JSON is invalid") from exc

    @staticmethod
    def replay(events: Iterable[ControllerEvent]) -> RunSnapshot:
        values = tuple(events)
        if not verify_controller_event_chain(values):
            raise ValueError("invalid controller event chain")
        allowed_types = {
            "dependency_added",
            "execution_settled",
            "run_created",
            "snapshot",
        }
        if values[0].type != "run_created" or any(
            event.type not in allowed_types for event in values
        ):
            raise ValueError("controller event stream has an invalid event type")
        snapshots = [event for event in values if event.type == "snapshot"]
        if not snapshots:
            raise ValueError("controller event stream contains no snapshot")
        replayed: list[RunSnapshot] = []
        for event in snapshots:
            snapshot = RunSnapshot.from_dict(event.detail["snapshot"])
            _validate_snapshot(snapshot, expected_run_id=values[0].run_id)
            replayed.append(snapshot)
        return replayed[-1]

    async def _ingest_locked(
        self,
        state: MutableRunState,
        execution: ExecutionRecord,
        result: AgentResult,
    ) -> tuple[ProposalDecision, ...]:
        prior = state.processed_results.get(execution.execution_id)
        if prior is not None:
            return prior
        node = state.nodes[execution.node_id]
        error = _validate_result(
            result=result,
            expected_node_id=node.node_id,
            max_text_length=state.policy.max_text_length,
            max_id_length=state.policy.max_id_length,
            max_events=state.policy.max_events_per_result,
            max_proposals=state.policy.max_proposals_per_result,
            max_usage_tokens=state.policy.max_total_tokens,
        )
        reserved = execution.reserved_tokens
        state.reserved_tokens -= reserved
        if error is not None:
            state.committed_tokens += reserved
            state.nodes[node.node_id] = replace(node, state=NodeState.FAILED)
            state.executions[execution.execution_id] = replace(
                execution,
                state=ExecutionState.FAILED,
                committed_tokens=reserved,
            )
            state.processed_results[execution.execution_id] = ()
            self._append_event(
                state.run_id,
                "execution_settled",
                {"node_id": node.node_id, "state": "failed", "code": error},
            )
            return ()

        actual = result.usage.total_tokens
        if actual > reserved:
            state.committed_tokens += reserved
            state.nodes[node.node_id] = replace(node, state=NodeState.FAILED)
            state.executions[execution.execution_id] = replace(
                execution,
                state=ExecutionState.FAILED,
                committed_tokens=reserved,
                event_chain_head=result.events[-1].event_hash,
            )
            state.processed_results[execution.execution_id] = ()
            self._append_event(
                state.run_id,
                "execution_settled",
                {
                    "node_id": node.node_id,
                    "state": "failed",
                    "code": "USAGE_EXCEEDS_RESERVATION",
                },
            )
            return ()
        committed = min(max(actual, 0), reserved)
        succeeded = result.status is NodeStatus.COMPLETED
        committed = committed if succeeded else reserved
        state.committed_tokens += committed
        state.nodes[node.node_id] = replace(
            node, state=NodeState.SUCCEEDED if succeeded else NodeState.FAILED
        )
        state.executions[execution.execution_id] = replace(
            execution,
            state=ExecutionState.SUCCEEDED if succeeded else ExecutionState.FAILED,
            committed_tokens=committed,
            event_chain_head=result.events[-1].event_hash,
        )
        decisions: tuple[ProposalDecision, ...] = ()
        if succeeded:
            produced: list[ProposalDecision] = []
            for ordinal, proposal in enumerate(result.spawn_proposals):
                produced.append(self._apply_spawn(state, node, proposal, ordinal, result))
            for ordinal, proposal in enumerate(result.message_proposals):
                produced.append(self._apply_message(state, node, proposal, ordinal))
            for ordinal, proposal in enumerate(result.skip_context_proposals):
                produced.append(self._apply_skip(state, node, proposal, ordinal))
            decisions = tuple(produced)
            state.decisions.extend(decisions)
        state.processed_results[execution.execution_id] = decisions
        self._append_event(
            state.run_id,
            "execution_settled",
            {
                "node_id": node.node_id,
                "state": "succeeded" if succeeded else "failed",
                "committed_tokens": committed,
            },
        )
        return decisions

    def _apply_spawn(
        self,
        state: MutableRunState,
        parent: NodeRecord,
        proposal: SpawnProposal,
        ordinal: int,
        result: AgentResult,
    ) -> ProposalDecision:
        rejected = self._validate_spawn(state, parent, proposal)
        if rejected is not None:
            return _rejected(proposal, "spawn", parent.node_id, *rejected)
        child_id = _deterministic_id(
            "node", state.run_id, parent.node_id, str(ordinal), proposal.proposal_id
        )
        if child_id in state.nodes:
            return _rejected(
                proposal, "spawn", parent.node_id, "DUPLICATE_PROPOSAL", "Duplicate child"
            )
        allocation = max(1, math.floor(parent.allocation_tokens * proposal.budget_share))
        spec = AgentSpec(
            identity=AgentIdentity(
                node_id=child_id,
                name=f"{proposal.role.title()} Agent",
                role=proposal.role,
                generation=parent.generation + 1,
                parent_node_id=parent.node_id,
                trust_score=min(
                    state.specs[parent.node_id].identity.trust_score, 1.0
                ),
            ),
            instructions=proposal.instructions,
            budget=_child_budget(state.specs[parent.node_id].budget, allocation),
            policy=state.specs[parent.node_id].policy,
            metadata={"objective": proposal.objective},
        )
        child = NodeRecord(
            node_id=child_id,
            name=spec.identity.name,
            role=proposal.role,
            parent_node_id=parent.node_id,
            generation=parent.generation + 1,
            priority=proposal.priority,
            state=NodeState.READY,
            allowed_tool_names=tuple(proposal.tool_names),
            allocation_tokens=allocation,
        )
        if allocation > (
            state.policy.max_total_tokens
            - state.committed_tokens
            - state.reserved_tokens
        ):
            return _rejected(
                proposal,
                "spawn",
                parent.node_id,
                "TOKEN_BUDGET_EXHAUSTED",
                "Insufficient global token budget",
            )
        try:
            runner = self._factory.create(
                spec=spec, tool_names=child.allowed_tool_names
            )
        except Exception:
            return _rejected(
                proposal,
                "spawn",
                parent.node_id,
                "FACTORY_ERROR",
                "Controller could not create the approved child node",
            )
        state.nodes[child_id] = child
        state.specs[child_id] = spec
        state.runners[child_id] = runner
        state.inputs[child_id] = AgentInput(
            task=proposal.objective,
            context=(
                ContextPacket(
                    source_node_id=parent.node_id,
                    content=result.output or "",
                    trust=state.specs[parent.node_id].identity.trust_score,
                    edge_type=EdgeType.SPAWN.value,
                ),
            ),
            metadata={"proposal_id": proposal.proposal_id},
        )
        state.node_reservations[child_id] = allocation
        state.reserved_tokens += allocation
        edge_id = _deterministic_id("edge", state.run_id, parent.node_id, child_id)
        state.edges.append(
            EdgeRecord(
                edge_id=edge_id,
                source_node_id=parent.node_id,
                target_node_id=child_id,
                type=EdgeType.SPAWN,
                priority=proposal.priority,
                weight=proposal.budget_share,
            )
        )
        return ProposalDecision(
            proposal_id=proposal.proposal_id,
            proposal_type="spawn",
            source_node_id=parent.node_id,
            state=DecisionState.ACCEPTED,
            code="ACCEPTED",
            message="Child node materialized",
            materialized_id=child_id,
        )

    def _validate_spawn(
        self,
        state: MutableRunState,
        parent: NodeRecord,
        proposal: SpawnProposal,
    ) -> tuple[str, str] | None:
        if not isinstance(proposal, SpawnProposal):
            return "MALFORMED_PROPOSAL", "Spawn proposal has invalid type"
        if proposal.parent_node_id != parent.node_id:
            return "SOURCE_MISMATCH", "Spawn parent does not match executing node"
        if proposal.generation != parent.generation + 1:
            return "GENERATION_MISMATCH", "Spawn generation is invalid"
        if type(proposal.generation) is not int:
            return "MALFORMED_PROPOSAL", "Spawn generation must be an integer"
        if proposal.generation > state.policy.max_generation:
            return "DEPTH_LIMIT", "Controller depth limit reached"
        if len(state.nodes) >= state.policy.max_nodes:
            return "NODE_LIMIT", "Controller node limit reached"
        if len(state.edges) >= state.policy.max_edges:
            return "EDGE_LIMIT", "Controller edge limit reached"
        children = sum(
            edge.type is EdgeType.SPAWN and edge.source_node_id == parent.node_id
            for edge in state.edges
        )
        if children >= state.policy.max_children_per_node:
            return "CHILD_LIMIT", "Controller child limit reached"
        try:
            tools = _normalize_tools(
                proposal.tool_names, max_length=state.policy.max_id_length
            )
            _validate_text(proposal.proposal_id, state.policy.max_id_length)
            _validate_priority(proposal.priority)
            _validate_unit(proposal.budget_share, positive=True)
            _validate_text(proposal.role, state.policy.max_text_length)
            _validate_text(proposal.objective, state.policy.max_text_length)
            _validate_text(proposal.instructions, state.policy.max_text_length)
        except (TypeError, ValueError) as exc:
            return "MALFORMED_PROPOSAL", str(exc)
        if not set(tools).issubset(parent.allowed_tool_names):
            return "PERMISSION_ESCALATION", "Child requested unauthorized tools"
        allocated = sum(
            edge.weight
            for edge in state.edges
            if edge.type is EdgeType.SPAWN and edge.source_node_id == parent.node_id
        )
        if allocated + proposal.budget_share > 1:
            return "INVALID_BUDGET_SHARE", "Child budgets exceed parent allocation"
        return None

    def _apply_message(
        self,
        state: MutableRunState,
        source: NodeRecord,
        proposal: MessageProposal,
        ordinal: int,
    ) -> ProposalDecision:
        if not isinstance(proposal, MessageProposal):
            return _rejected(
                proposal, "message", source.node_id, "MALFORMED_PROPOSAL", "Invalid message"
            )
        try:
            _validate_text(proposal.proposal_id, state.policy.max_id_length)
            _validate_text(proposal.source_node_id, state.policy.max_id_length)
            _validate_text(proposal.target_node_id, state.policy.max_id_length)
            _validate_text(proposal.content, state.policy.max_text_length)
            _validate_priority(proposal.priority)
            if (
                type(proposal.ttl_seconds) is not int
                or not 1 <= proposal.ttl_seconds <= state.policy.max_message_ttl_seconds
            ):
                raise ValueError("ttl_seconds must be a bounded integer")
        except (TypeError, ValueError) as exc:
            return _rejected(
                proposal, "message", source.node_id, "MALFORMED_PROPOSAL", str(exc)
            )
        if proposal.source_node_id != source.node_id:
            return _rejected(
                proposal, "message", source.node_id, "SOURCE_MISMATCH", "Invalid source"
            )
        if proposal.target_node_id not in state.nodes:
            return _rejected(
                proposal, "message", source.node_id, "TARGET_NOT_FOUND", "Target not found"
            )
        if proposal.target_node_id == source.node_id:
            return _rejected(
                proposal, "message", source.node_id, "SELF_EDGE", "Message edge rejected"
            )
        if len(state.edges) >= state.policy.max_edges:
            return _rejected(
                proposal, "message", source.node_id, "EDGE_LIMIT", "Controller edge limit reached"
            )
        edge_id = _deterministic_id(
            "message", state.run_id, source.node_id, str(ordinal), proposal.proposal_id
        )
        state.edges.append(
            EdgeRecord(
                edge_id=edge_id,
                source_node_id=source.node_id,
                target_node_id=proposal.target_node_id,
                type=EdgeType.MESSAGE,
                priority=proposal.priority,
                ttl_seconds=proposal.ttl_seconds,
                content_hash=_content_hash(proposal.content),
            )
        )
        return _accepted(proposal, "message", source.node_id, edge_id)

    def _apply_skip(
        self,
        state: MutableRunState,
        requester: NodeRecord,
        proposal: SkipContextProposal,
        ordinal: int,
    ) -> ProposalDecision:
        if not isinstance(proposal, SkipContextProposal):
            return _rejected(
                proposal, "skip_context", requester.node_id, "MALFORMED_PROPOSAL", "Invalid skip"
            )
        try:
            _validate_text(proposal.proposal_id, state.policy.max_id_length)
            _validate_text(proposal.requester_node_id, state.policy.max_id_length)
            _validate_text(proposal.source_node_id, state.policy.max_id_length)
            _validate_text(proposal.reason, state.policy.max_text_length)
            _validate_unit(proposal.context_gate)
        except (TypeError, ValueError) as exc:
            return _rejected(
                proposal, "skip_context", requester.node_id, "MALFORMED_PROPOSAL", str(exc)
            )
        if proposal.requester_node_id != requester.node_id:
            return _rejected(
                proposal, "skip_context", requester.node_id, "SOURCE_MISMATCH", "Invalid requester"
            )
        if proposal.source_node_id not in state.nodes:
            return _rejected(
                proposal, "skip_context", requester.node_id, "TARGET_NOT_FOUND", "Source not found"
            )
        if not _is_ancestor(state, proposal.source_node_id, requester.node_id):
            return _rejected(
                proposal,
                "skip_context",
                requester.node_id,
                "POLICY_DENIED",
                "Skip context source must be an ancestor",
            )
        if len(state.edges) >= state.policy.max_edges:
            return _rejected(
                proposal,
                "skip_context",
                requester.node_id,
                "EDGE_LIMIT",
                "Controller edge limit reached",
            )
        edge_id = _deterministic_id(
            "skip", state.run_id, requester.node_id, str(ordinal), proposal.proposal_id
        )
        state.edges.append(
            EdgeRecord(
                edge_id=edge_id,
                source_node_id=proposal.source_node_id,
                target_node_id=requester.node_id,
                type=EdgeType.SKIP_CONTEXT,
                weight=proposal.context_gate,
                content_hash=_content_hash(proposal.reason),
            )
        )
        return _accepted(proposal, "skip_context", requester.node_id, edge_id)

    def _settle_exception(
        self,
        state: MutableRunState,
        node: NodeRecord,
        execution: ExecutionRecord,
        error: BaseException,
    ) -> None:
        state.reserved_tokens -= execution.reserved_tokens
        state.committed_tokens += execution.reserved_tokens
        state.nodes[node.node_id] = replace(node, state=NodeState.FAILED)
        state.executions[execution.execution_id] = replace(
            execution,
            state=ExecutionState.FAILED,
            committed_tokens=execution.reserved_tokens,
        )
        state.processed_results[execution.execution_id] = ()
        self._append_event(
            state.run_id,
            "execution_settled",
            {"node_id": node.node_id, "state": "failed", "code": type(error).__name__},
        )

    def _cancel_claims(
        self,
        state: MutableRunState,
        claims: Iterable[tuple[NodeRecord, ExecutionRecord, NodeRunner, AgentInput]],
    ) -> None:
        for node, execution, _, _ in claims:
            current = state.executions[execution.execution_id]
            if current.state is not ExecutionState.RUNNING:
                continue
            state.reserved_tokens -= execution.reserved_tokens
            state.nodes[node.node_id] = replace(node, state=NodeState.CANCELLED)
            state.executions[execution.execution_id] = replace(
                execution, state=ExecutionState.CANCELLED
            )
            state.processed_results[execution.execution_id] = ()
            self._append_event(
                state.run_id,
                "execution_settled",
                {"node_id": node.node_id, "state": "cancelled", "code": "CANCELLED"},
            )
        for node in tuple(state.nodes.values()):
            if node.state is not NodeState.READY:
                continue
            reservation = state.node_reservations.pop(node.node_id, 0)
            state.reserved_tokens -= reservation
            state.nodes[node.node_id] = replace(node, state=NodeState.CANCELLED)
        state.status = RunStatus.CANCELLED

    def _settle_run(self, state: MutableRunState) -> None:
        pending = any(
            node.state in {NodeState.READY, NodeState.RUNNING}
            for node in state.nodes.values()
        )
        if pending:
            state.status = RunStatus.RUNNING
        elif any(node.state is NodeState.CANCELLED for node in state.nodes.values()):
            state.status = RunStatus.CANCELLED
        elif any(
            node.state in {NodeState.FAILED, NodeState.BLOCKED}
            for node in state.nodes.values()
        ):
            state.status = RunStatus.FAILED
        else:
            state.status = RunStatus.SUCCEEDED

    def _block_failed_dependents(self, state: MutableRunState) -> None:
        changed = True
        while changed:
            changed = False
            for node in tuple(state.nodes.values()):
                if node.state is not NodeState.READY:
                    continue
                dependency_states = [
                    state.nodes[edge.source_node_id].state
                    for edge in state.edges
                    if edge.type is EdgeType.DEPENDS_ON
                    and edge.target_node_id == node.node_id
                ]
                if any(
                    value in {NodeState.FAILED, NodeState.CANCELLED, NodeState.BLOCKED}
                    for value in dependency_states
                ):
                    state.nodes[node.node_id] = replace(
                        node, state=NodeState.BLOCKED
                    )
                    reservation = state.node_reservations.pop(node.node_id, 0)
                    state.reserved_tokens -= reservation
                    changed = True

    def _dependencies_satisfied(
        self, state: MutableRunState, node_id: str
    ) -> bool:
        sources = (
            edge.source_node_id
            for edge in state.edges
            if edge.type is EdgeType.DEPENDS_ON and edge.target_node_id == node_id
        )
        return all(state.nodes[source].state is NodeState.SUCCEEDED for source in sources)

    def _snapshot(self, state: MutableRunState) -> RunSnapshot:
        nodes = tuple(sorted(state.nodes.values(), key=lambda item: item.node_id))
        edges = tuple(sorted(state.edges, key=lambda item: item.edge_id))
        executions = tuple(
            sorted(state.executions.values(), key=lambda item: item.sequence)
        )
        decisions = tuple(state.decisions)
        return RunSnapshot(
            run_id=state.run_id,
            status=state.status,
            nodes=nodes,
            edges=edges,
            executions=executions,
            decisions=decisions,
            budget=BudgetSnapshot(
                limit_tokens=state.policy.max_total_tokens,
                committed_tokens=state.committed_tokens,
                reserved_tokens=state.reserved_tokens,
            ),
            pending_executions=sum(
                node.state in {NodeState.READY, NodeState.RUNNING} for node in nodes
            ),
            superstep=state.superstep,
        )

    def _append_event(
        self, run_id: str, event_type: str, detail: Mapping[str, Any]
    ) -> ControllerEvent:
        events = self._store.run_events[run_id]
        event = create_controller_event(
            sequence=len(events),
            run_id=run_id,
            event_type=event_type,
            detail=detail,
            previous_hash=events[-1].event_hash if events else CONTROLLER_GENESIS_HASH,
        )
        events.append(event)
        return event

    def _append_snapshot_event(self, state: MutableRunState) -> None:
        self._append_event(
            state.run_id, "snapshot", {"snapshot": self._snapshot(state).to_dict()}
        )

    def _state(self, run_id: str) -> MutableRunState:
        try:
            return self._store.runs[run_id]
        except KeyError as exc:
            raise KeyError(f"unknown run_id: {run_id}") from exc


def _validate_result(
    *,
    result: AgentResult,
    expected_node_id: str,
    max_text_length: int,
    max_id_length: int,
    max_events: int,
    max_proposals: int,
    max_usage_tokens: int,
) -> str | None:
    try:
        if not isinstance(result, AgentResult) or result.node_id != expected_node_id:
            return "SOURCE_MISMATCH"
        if (
            not isinstance(result.events, tuple)
            or not result.events
            or len(result.events) > max_events
            or any(type(event) is not RunEvent for event in result.events)
            or not verify_event_chain(result.events)
        ):
            return "INVALID_EVENT_CHAIN"
        if any(event.node_id != expected_node_id for event in result.events):
            return "SOURCE_MISMATCH"
        if result.events[0].type is not EventType.NODE_STARTED:
            return "INVALID_EVENT_STATE"
        terminal = result.events[-1].type
        if result.status is NodeStatus.COMPLETED:
            if terminal is not EventType.NODE_COMPLETED or result.error is not None:
                return "INVALID_EVENT_STATE"
        elif result.status is NodeStatus.FAILED:
            if (
                terminal not in {EventType.NODE_FAILED, EventType.BUDGET_EXCEEDED}
                or type(result.error) is not NodeError
            ):
                return "INVALID_EVENT_STATE"
            _validate_text(result.error.code, max_id_length)
            _validate_text(result.error.message, max_text_length)
            if type(result.error.retryable) is not bool:
                return "MALFORMED_RESULT"
        else:
            return "INVALID_NODE_STATUS"
        for event in result.events:
            if (
                type(event.type) is not EventType
                or event.node_id != expected_node_id
                or len(event.metadata_json) > max_text_length
                or type(event.timestamp) not in {int, float}
                or not math.isfinite(event.timestamp)
                or not _is_sha256(event.input_hash)
                or not _is_sha256(event.output_hash)
                or not _is_sha256(event.previous_hash)
                or not _is_sha256(event.event_hash)
                or not isinstance(event.metadata, Mapping)
            ):
                return "INVALID_EVENT_SCHEMA"
        if result.output is not None:
            _validate_text(result.output, max_text_length)
        if (
            type(result.usage) is not Usage
            or
            type(result.usage.input_tokens) is not int
            or type(result.usage.output_tokens) is not int
            or result.usage.input_tokens < 0
            or result.usage.output_tokens < 0
            or result.usage.input_tokens > max_usage_tokens
            or result.usage.output_tokens > max_usage_tokens
        ):
            return "INVALID_USAGE"
        if not all(
            isinstance(values, tuple)
            for values in (
                result.spawn_proposals,
                result.message_proposals,
                result.skip_context_proposals,
            )
        ):
            return "MALFORMED_RESULT"
        proposal_count = (
            len(result.spawn_proposals)
            + len(result.message_proposals)
            + len(result.skip_context_proposals)
        )
        if proposal_count > max_proposals:
            return "PROPOSAL_LIMIT"
        for proposal in (
            *result.spawn_proposals,
            *result.message_proposals,
            *result.skip_context_proposals,
        ):
            _validate_text(_proposal_id(proposal), max_id_length)
        expected_result_hash = result_binding_hash(
            node_id=result.node_id,
            status=result.status.value,
            output=result.output,
            input_tokens=result.usage.input_tokens,
            output_tokens=result.usage.output_tokens,
            spawn_proposals=result.spawn_proposals,
            message_proposals=result.message_proposals,
            skip_context_proposals=result.skip_context_proposals,
            error=result.error,
        )
        if result.events[-1].metadata.get("result_hash") != expected_result_hash:
            return "RESULT_BINDING_MISMATCH"
    except Exception:
        return "MALFORMED_RESULT"
    return None


def _normalize_tools(
    values: Iterable[str], *, max_length: int = 256
) -> tuple[str, ...]:
    if isinstance(values, (str, bytes)):
        raise TypeError("tool names must be an iterable of strings")
    normalized = tuple(values)
    if any(
        not isinstance(value, str)
        or not value.strip()
        or len(value) > max_length
        for value in normalized
    ):
        raise TypeError("tool names must be non-empty strings")
    if len(normalized) != len(set(normalized)):
        raise ValueError("tool names must be unique")
    return normalized


def _validate_text(value: Any, limit: int) -> str:
    if not isinstance(value, str) or not value.strip():
        raise TypeError("text value must be a non-empty string")
    if len(value) > limit:
        raise ValueError("text value exceeds controller limit")
    return value


def _validate_priority(value: Any) -> float:
    return _validate_unit(value)


def _validate_unit(value: Any, *, positive: bool = False) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError("weight must be numeric")
    number = float(value)
    if not math.isfinite(number) or not 0 <= number <= 1:
        raise ValueError("weight must be finite and between 0 and 1")
    if positive and number == 0:
        raise ValueError("weight must be positive")
    return number


def _child_budget(parent: NodeBudget, tokens: int) -> NodeBudget:
    return NodeBudget(
        max_turns=max(1, parent.max_turns),
        max_tool_calls=max(0, parent.max_tool_calls),
        max_total_tokens=max(1, tokens),
        timeout_seconds=parent.timeout_seconds,
    )


def _deterministic_id(kind: str, *parts: str) -> str:
    digest = hashlib.sha256("\x1f".join(parts).encode("utf-8")).hexdigest()[:20]
    return f"{kind}-{digest}"


def _content_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _is_sha256(value: Any) -> bool:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdef" for character in value)
    )


def _proposal_id(proposal: Any) -> str:
    value = getattr(proposal, "proposal_id", "invalid")
    return value if isinstance(value, str) else "invalid"


def _rejected(
    proposal: Any,
    proposal_type: str,
    source: str,
    code: str,
    message: str,
) -> ProposalDecision:
    return ProposalDecision(
        proposal_id=_proposal_id(proposal),
        proposal_type=proposal_type,
        source_node_id=source,
        state=DecisionState.REJECTED,
        code=code,
        message=message,
    )


def _accepted(
    proposal: Any, proposal_type: str, source: str, materialized_id: str
) -> ProposalDecision:
    return ProposalDecision(
        proposal_id=_proposal_id(proposal),
        proposal_type=proposal_type,
        source_node_id=source,
        state=DecisionState.ACCEPTED,
        code="ACCEPTED",
        message="Graph edge materialized",
        materialized_id=materialized_id,
    )


def _is_ancestor(state: MutableRunState, source: str, target: str) -> bool:
    current = state.nodes[target].parent_node_id
    while current is not None:
        if current == source:
            return True
        current = state.nodes[current].parent_node_id
    return False


def _reachable(state: MutableRunState, source: str, target: str) -> bool:
    adjacency: dict[str, list[str]] = {}
    for edge in state.edges:
        if edge.type in {EdgeType.SPAWN, EdgeType.DEPENDS_ON}:
            adjacency.setdefault(edge.source_node_id, []).append(edge.target_node_id)
    pending = [source]
    visited: set[str] = set()
    while pending:
        current = pending.pop()
        if current == target:
            return True
        if current in visited:
            continue
        visited.add(current)
        pending.extend(adjacency.get(current, ()))
    return False


def _validate_snapshot(snapshot: RunSnapshot, *, expected_run_id: str) -> None:
    try:
        if snapshot.run_id != expected_run_id or not snapshot.run_id:
            raise ValueError("snapshot run_id is invalid")
        node_ids = [node.node_id for node in snapshot.nodes]
        edge_ids = [edge.edge_id for edge in snapshot.edges]
        execution_ids = [value.execution_id for value in snapshot.executions]
        if len(node_ids) != len(set(node_ids)) or not all(node_ids):
            raise ValueError("snapshot node IDs are invalid")
        if len(edge_ids) != len(set(edge_ids)) or not all(edge_ids):
            raise ValueError("snapshot edge IDs are invalid")
        if len(execution_ids) != len(set(execution_ids)) or not all(execution_ids):
            raise ValueError("snapshot execution IDs are invalid")
        known = set(node_ids)
        if any(
            edge.source_node_id not in known or edge.target_node_id not in known
            for edge in snapshot.edges
        ):
            raise ValueError("snapshot edge endpoint is invalid")
        if any(value.node_id not in known for value in snapshot.executions):
            raise ValueError("snapshot execution endpoint is invalid")
        budget = snapshot.budget
        if (
            type(budget.limit_tokens) is not int
            or type(budget.committed_tokens) is not int
            or type(budget.reserved_tokens) is not int
            or budget.limit_tokens < 1
            or budget.committed_tokens < 0
            or budget.reserved_tokens < 0
            or budget.committed_tokens + budget.reserved_tokens > budget.limit_tokens
        ):
            raise ValueError("snapshot budget is invalid")
        pending = sum(
            node.state in {NodeState.READY, NodeState.RUNNING}
            for node in snapshot.nodes
        )
        if snapshot.pending_executions != pending:
            raise ValueError("snapshot pending count is invalid")
        if type(snapshot.superstep) is not int or snapshot.superstep < 0:
            raise ValueError("snapshot superstep is invalid")
        terminal_nodes = {NodeState.SUCCEEDED, NodeState.FAILED, NodeState.CANCELLED}
        for execution in snapshot.executions:
            if execution.reserved_tokens < 1 or execution.committed_tokens < 0:
                raise ValueError("snapshot execution budget is invalid")
            if execution.committed_tokens > execution.reserved_tokens:
                raise ValueError("snapshot execution budget exceeds reservation")
        if snapshot.status is RunStatus.SUCCEEDED and any(
            node.state not in terminal_nodes or node.state is not NodeState.SUCCEEDED
            for node in snapshot.nodes
        ):
            raise ValueError("successful snapshot contains non-successful nodes")
        if snapshot.status is not RunStatus.RUNNING and pending:
            raise ValueError("terminal snapshot contains pending nodes")
    except (AttributeError, TypeError) as exc:
        raise ValueError("snapshot schema is invalid") from exc


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    value: dict[str, Any] = {}
    for key, item in pairs:
        if key in value:
            raise ValueError(f"duplicate JSON key: {key}")
        value[key] = item
    return value


def _raise_invalid_constant(constant: str) -> Any:
    raise ValueError(f"invalid JSON constant: {constant}")
