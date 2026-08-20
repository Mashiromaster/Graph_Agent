import { describe, expect, it } from "vitest";
import {
  EventRecorder,
  EventType,
  NodeStatus,
  createAgentInput,
  createAgentResult,
  createMessageProposal,
  createNodeError,
  createSkipContextProposal,
  createSpawnProposal,
  createUsage,
  resultBindingHash,
  type AgentInput,
  type AgentResult,
} from "@graph-agent/core";
import { createControllerPolicy } from "../src/policy.js";
import {
  NodeState,
  ExecutionState,
  RunStatus,
  EdgeType,
  createEdgeRecord,
  createNodeRecord,
  type NodeRecord,
} from "../src/graph-models.js";
import { createMutableRunState, type MutableRunState } from "../src/mutable-state.js";
import type { ControllerEventType } from "../src/controller-events.js";
import type { NodeFactory, NodeRunner } from "../src/runner.js";
import {
  blockFailedDependents,
  cancelClaims,
  freezeFrontierAndClaim,
  ingestLocked,
  settleException,
  settleRun,
  type Claim,
} from "../src/scheduler.js";

const RUN_ID = "run-1";

// ── event collector ────────────────────────────────────────────────────────

interface CapturedEvent {
  type: ControllerEventType;
  detail: Record<string, unknown>;
}

function makeAppend(sink: CapturedEvent[]) {
  return (type: ControllerEventType, detail: object): void => {
    sink.push({ type, detail: detail as Record<string, unknown> });
  };
}

// ── stub runner/factory ──────────────────────────────────────────────────────

const stubRunner: NodeRunner = {
  spec: { identity: {} as never, budget: {} as never },
  run: async () => {
    throw new Error("not used");
  },
};

const stubFactory: NodeFactory = {
  create: () => stubRunner,
};

// ── state builders ───────────────────────────────────────────────────────────

function makeNode(overrides: Partial<NodeRecord> & { nodeId: string }): NodeRecord {
  return createNodeRecord({
    nodeId: overrides.nodeId,
    name: overrides.name ?? "Node",
    role: overrides.role ?? "worker",
    parentNodeId: overrides.parentNodeId ?? null,
    generation: overrides.generation ?? 0,
    priority: overrides.priority ?? 0.5,
    state: overrides.state ?? NodeState.READY,
    allowedToolNames: overrides.allowedToolNames ?? ["search", "fetch"],
    allocationTokens: overrides.allocationTokens ?? 1000,
  });
}

function baseState(): MutableRunState {
  const policy = createControllerPolicy();
  return createMutableRunState(RUN_ID, policy);
}

function addReadyNode(
  state: MutableRunState,
  node: NodeRecord,
  reservation: number,
  input?: AgentInput,
): void {
  state.nodes.set(node.nodeId, node);
  state.runners.set(node.nodeId, stubRunner);
  state.inputs.set(
    node.nodeId,
    input ?? createAgentInput({ task: "t", context: [], sessionId: node.nodeId }),
  );
  if (reservation > 0) {
    state.nodeReservations.set(node.nodeId, reservation);
    state.reservedTokens += reservation;
  }
}

// ── result fixtures (genuine event chains + result binding) ──────────────────

function completedResult(
  nodeId: string,
  inputTokens: number,
  outputTokens: number,
  proposals?: {
    spawnProposals?: readonly unknown[];
    messageProposals?: readonly unknown[];
    skipContextProposals?: readonly unknown[];
  },
): AgentResult {
  const output = "done";
  const spawnProposals = (proposals?.spawnProposals ?? []) as never;
  const messageProposals = (proposals?.messageProposals ?? []) as never;
  const skipContextProposals = (proposals?.skipContextProposals ?? []) as never;
  const resultHash = resultBindingHash({
    nodeId,
    status: NodeStatus.COMPLETED,
    output,
    inputTokens,
    outputTokens,
    spawnProposals,
    messageProposals,
    skipContextProposals,
  });
  const recorder = new EventRecorder(nodeId, () => 0);
  recorder.record({ type: EventType.NODE_STARTED });
  recorder.record({
    type: EventType.NODE_COMPLETED,
    metadata: { result_hash: resultHash },
  });
  return createAgentResult({
    nodeId,
    status: NodeStatus.COMPLETED,
    output,
    usage: createUsage({ inputTokens, outputTokens }),
    events: recorder.events,
    spawnProposals,
    messageProposals,
    skipContextProposals,
  });
}

function failedResult(nodeId: string, inputTokens: number, outputTokens: number): AgentResult {
  const output = null;
  const error = createNodeError({ code: "boom", message: "failed", retryable: false });
  const resultHash = resultBindingHash({
    nodeId,
    status: NodeStatus.FAILED,
    output,
    inputTokens,
    outputTokens,
    error,
  });
  const recorder = new EventRecorder(nodeId, () => 0);
  recorder.record({ type: EventType.NODE_STARTED });
  recorder.record({
    type: EventType.NODE_FAILED,
    metadata: { result_hash: resultHash },
  });
  return createAgentResult({
    nodeId,
    status: NodeStatus.FAILED,
    output,
    usage: createUsage({ inputTokens, outputTokens }),
    events: recorder.events,
    error,
  });
}

// ── freezeFrontierAndClaim ───────────────────────────────────────────────────

describe("freezeFrontierAndClaim", () => {
  it("claims READY nodes sorted by (-priority, nodeId), assigns monotonic sequences, marks RUNNING", () => {
    const state = baseState();
    addReadyNode(state, makeNode({ nodeId: "a", priority: 0.2 }), 100);
    addReadyNode(state, makeNode({ nodeId: "b", priority: 0.9 }), 200);

    const claims = freezeFrontierAndClaim(state);

    // b has higher priority -> first
    expect(claims.map((c) => c.node.nodeId)).toEqual(["b", "a"]);
    expect(claims[0]!.execution.sequence).toBe(0);
    expect(claims[1]!.execution.sequence).toBe(1);
    expect(claims[0]!.execution.reservedTokens).toBe(200);
    expect(claims[1]!.execution.reservedTokens).toBe(100);
    // nodes now RUNNING
    expect(state.nodes.get("a")!.state).toBe(NodeState.RUNNING);
    expect(state.nodes.get("b")!.state).toBe(NodeState.RUNNING);
    expect(claims[0]!.node.state).toBe(NodeState.RUNNING);
    // executions registered, RUNNING, reservations consumed off the map (aggregate unchanged)
    expect(state.executions.size).toBe(2);
    expect([...state.executions.values()].every((e) => e.state === ExecutionState.RUNNING)).toBe(true);
    expect(state.nodeReservations.size).toBe(0);
    expect(state.reservedTokens).toBe(300);
    expect(state.enqueueSequence).toBe(2);
    expect(state.superstep).toBe(1);
    expect(claims[0]!.runner).toBe(stubRunner);
  });

  it("a node with reservation < 1 is FAILED and yields no claim", () => {
    const state = baseState();
    addReadyNode(state, makeNode({ nodeId: "a", priority: 0.9 }), 100);
    // manually add a node with a zero reservation
    const bad = makeNode({ nodeId: "z", priority: 0.9 });
    state.nodes.set(bad.nodeId, bad);
    state.nodeReservations.set(bad.nodeId, 0);

    const claims = freezeFrontierAndClaim(state);

    expect(claims.map((c) => c.node.nodeId)).toEqual(["a"]);
    expect(state.nodes.get("z")!.state).toBe(NodeState.FAILED);
    expect(state.nodeReservations.has("z")).toBe(false);
  });

  it("a node whose depends_on source is not SUCCEEDED is NOT in the frontier", () => {
    const state = baseState();
    const dep = makeNode({ nodeId: "dep", state: NodeState.RUNNING });
    const child = makeNode({ nodeId: "child" });
    state.nodes.set(dep.nodeId, dep);
    addReadyNode(state, child, 100);
    state.edges.push(
      createEdgeRecord({
        edgeId: "e1",
        sourceNodeId: "dep",
        targetNodeId: "child",
        type: EdgeType.DEPENDS_ON,
      }),
    );

    const claims = freezeFrontierAndClaim(state);
    expect(claims).toEqual([]);
    expect(state.nodes.get("child")!.state).toBe(NodeState.READY);
  });

  it("a node whose depends_on source IS SUCCEEDED is in the frontier", () => {
    const state = baseState();
    const dep = makeNode({ nodeId: "dep", state: NodeState.SUCCEEDED });
    const child = makeNode({ nodeId: "child" });
    state.nodes.set(dep.nodeId, dep);
    addReadyNode(state, child, 100);
    state.edges.push(
      createEdgeRecord({
        edgeId: "e1",
        sourceNodeId: "dep",
        targetNodeId: "child",
        type: EdgeType.DEPENDS_ON,
      }),
    );

    const claims = freezeFrontierAndClaim(state);
    expect(claims.map((c) => c.node.nodeId)).toEqual(["child"]);
  });
});

// ── ingestLocked ─────────────────────────────────────────────────────────────

describe("ingestLocked", () => {
  function stateWithRunning(nodeId: string, reserved: number) {
    const state = baseState();
    addReadyNode(state, makeNode({ nodeId }), reserved);
    const claims = freezeFrontierAndClaim(state);
    const claim = claims.find((c) => c.node.nodeId === nodeId)!;
    return { state, node: claim.node, execution: claim.execution };
  }

  it("is idempotent: second call returns stored decisions with no double-commit", () => {
    const { state, node, execution } = stateWithRunning("n", 100);
    const events: CapturedEvent[] = [];
    const result = completedResult("n", 10, 5);

    const first = ingestLocked(state, execution, node, result, makeAppend(events));
    const committedAfterFirst = state.committedTokens;
    const reservedAfterFirst = state.reservedTokens;
    const eventCountAfterFirst = events.length;

    const second = ingestLocked(state, execution, node, result, makeAppend(events));
    expect(second).toBe(first);
    expect(state.committedTokens).toBe(committedAfterFirst);
    expect(state.reservedTokens).toBe(reservedAfterFirst);
    expect(events.length).toBe(eventCountAfterFirst);
  });

  it("fail-closed on invalid result: node FAILED, full reservation committed, no proposals", () => {
    const { state, node, execution } = stateWithRunning("n", 100);
    const events: CapturedEvent[] = [];
    // wrong nodeId -> SOURCE_MISMATCH
    const bad = completedResult("other", 10, 5);

    const decisions = ingestLocked(state, execution, node, bad, makeAppend(events));

    expect(decisions).toEqual([]);
    expect(state.nodes.get("n")!.state).toBe(NodeState.FAILED);
    expect(state.executions.get(execution.executionId)!.state).toBe(ExecutionState.FAILED);
    expect(state.executions.get(execution.executionId)!.committedTokens).toBe(100);
    // reserved down by 100, committed up by full 100
    expect(state.reservedTokens).toBe(0);
    expect(state.committedTokens).toBe(100);
    expect(state.processedResults.get(execution.executionId)).toEqual([]);
    expect(events.at(-1)!.detail).toMatchObject({ state: "failed" });
  });

  it("success within budget: node SUCCEEDED, committed=actual, unused released", () => {
    const { state, node, execution } = stateWithRunning("n", 100);
    const events: CapturedEvent[] = [];
    const result = completedResult("n", 10, 5); // actual = 15

    ingestLocked(state, execution, node, result, makeAppend(events));

    expect(state.nodes.get("n")!.state).toBe(NodeState.SUCCEEDED);
    expect(state.executions.get(execution.executionId)!.state).toBe(ExecutionState.SUCCEEDED);
    expect(state.executions.get(execution.executionId)!.committedTokens).toBe(15);
    expect(state.reservedTokens).toBe(0); // reserved -= 100
    expect(state.committedTokens).toBe(15); // committed += actual
    expect(events.at(-1)!.detail).toMatchObject({ state: "succeeded", committedTokens: 15 });
  });

  it("usage overrun -> USAGE_EXCEEDS_RESERVATION fail-closed (full commit)", () => {
    const { state, node, execution } = stateWithRunning("n", 10);
    const events: CapturedEvent[] = [];
    const result = completedResult("n", 30, 20); // actual = 50 > 10

    const decisions = ingestLocked(state, execution, node, result, makeAppend(events));

    expect(decisions).toEqual([]);
    expect(state.nodes.get("n")!.state).toBe(NodeState.FAILED);
    expect(state.committedTokens).toBe(10); // full reservation committed
    expect(state.reservedTokens).toBe(0);
    expect(events.at(-1)!.detail).toMatchObject({
      state: "failed",
      code: "USAGE_EXCEEDS_RESERVATION",
    });
  });

  it("FAILED status commits the full reservation and marks node FAILED", () => {
    const { state, node, execution } = stateWithRunning("n", 100);
    const events: CapturedEvent[] = [];
    const result = failedResult("n", 3, 0);

    const decisions = ingestLocked(state, execution, node, result, makeAppend(events));

    expect(decisions).toEqual([]);
    expect(state.nodes.get("n")!.state).toBe(NodeState.FAILED);
    expect(state.committedTokens).toBe(100);
    expect(state.reservedTokens).toBe(0);
  });

  it("processes proposals in fixed order: spawn, message, skip", () => {
    // Build a hierarchy: root(gen0) is the running node; it spawns a child,
    // messages a sibling target, and skips context from an ancestor.
    const state = baseState();
    // ancestor chain for skip: gp -> parent(running) ; source=gp is ancestor of parent
    const gp = makeNode({ nodeId: "gp", parentNodeId: null, generation: 0, state: NodeState.SUCCEEDED });
    state.nodes.set(gp.nodeId, gp);
    // a message target node
    const tgt = makeNode({ nodeId: "tgt", parentNodeId: "gp", generation: 1, state: NodeState.READY });
    state.nodes.set(tgt.nodeId, tgt);

    const runningNode = makeNode({
      nodeId: "parent",
      parentNodeId: "gp",
      generation: 1,
      allocationTokens: 1000,
      allowedToolNames: ["search"],
    });
    addReadyNode(state, runningNode, 100);
    const claims = freezeFrontierAndClaim(state);
    const claim = claims.find((c) => c.node.nodeId === "parent")!;

    const spawn = createSpawnProposal({
      proposalId: "sp-1",
      parentNodeId: "parent",
      generation: 2,
      role: "worker",
      objective: "o",
      instructions: "i",
      toolNames: ["search"],
      priority: 0.5,
      budgetShare: 0.25,
    });
    const message = createMessageProposal({
      proposalId: "m-1",
      sourceNodeId: "parent",
      targetNodeId: "tgt",
      content: "hi",
      priority: 0.5,
      ttlSeconds: 300,
    });
    const skip = createSkipContextProposal({
      proposalId: "sk-1",
      requesterNodeId: "parent",
      sourceNodeId: "gp",
      reason: "stale",
      contextGate: 0.5,
    });

    const result = completedResult("parent", 10, 5, {
      spawnProposals: [spawn],
      messageProposals: [message],
      skipContextProposals: [skip],
    });
    const events: CapturedEvent[] = [];
    const decisions = ingestLocked(
      state,
      claim.execution,
      claim.node,
      result,
      makeAppend(events),
      stubFactory,
    );

    expect(decisions.map((d) => d.proposalType)).toEqual(["spawn", "message", "skip"]);
    expect(decisions.every((d) => d.state === "accepted")).toBe(true);
    // decisions appended to state
    expect(state.decisions).toEqual(decisions);
  });
});

// ── settleException ──────────────────────────────────────────────────────────

describe("settleException", () => {
  it("commits full reservation, marks node/exec FAILED with error name as code", () => {
    const state = baseState();
    addReadyNode(state, makeNode({ nodeId: "n" }), 100);
    const claims = freezeFrontierAndClaim(state);
    const claim = claims[0]!;
    const events: CapturedEvent[] = [];

    settleException(state, claim.execution, claim.node, new RangeError("nope"), makeAppend(events));

    expect(state.nodes.get("n")!.state).toBe(NodeState.FAILED);
    expect(state.executions.get(claim.execution.executionId)!.state).toBe(ExecutionState.FAILED);
    expect(state.committedTokens).toBe(100);
    expect(state.reservedTokens).toBe(0);
    expect(state.processedResults.get(claim.execution.executionId)).toEqual([]);
    expect(events.at(-1)!.detail).toMatchObject({ state: "failed", code: "RangeError" });
  });

  it("uses UNKNOWN_ERROR for a non-Error throw", () => {
    const state = baseState();
    addReadyNode(state, makeNode({ nodeId: "n" }), 100);
    const claims = freezeFrontierAndClaim(state);
    const claim = claims[0]!;
    const events: CapturedEvent[] = [];

    settleException(state, claim.execution, claim.node, "string error", makeAppend(events));
    expect(events.at(-1)!.detail).toMatchObject({ code: "UNKNOWN_ERROR" });
  });
});

// ── blockFailedDependents ────────────────────────────────────────────────────

describe("blockFailedDependents", () => {
  it("blocks a READY node whose depends_on source is FAILED and releases its reservation", () => {
    const state = baseState();
    const failed = makeNode({ nodeId: "f", state: NodeState.FAILED });
    state.nodes.set(failed.nodeId, failed);
    addReadyNode(state, makeNode({ nodeId: "dependent" }), 100);
    state.edges.push(
      createEdgeRecord({
        edgeId: "e1",
        sourceNodeId: "f",
        targetNodeId: "dependent",
        type: EdgeType.DEPENDS_ON,
      }),
    );

    blockFailedDependents(state);

    expect(state.nodes.get("dependent")!.state).toBe(NodeState.BLOCKED);
    expect(state.nodeReservations.has("dependent")).toBe(false);
    expect(state.reservedTokens).toBe(0);
    expect(state.committedTokens).toBe(0); // released, NOT committed
  });

  it("cascades transitively (fixpoint)", () => {
    const state = baseState();
    const failed = makeNode({ nodeId: "f", state: NodeState.FAILED });
    state.nodes.set(failed.nodeId, failed);
    addReadyNode(state, makeNode({ nodeId: "mid" }), 100);
    addReadyNode(state, makeNode({ nodeId: "leaf" }), 100);
    state.edges.push(
      createEdgeRecord({ edgeId: "e1", sourceNodeId: "f", targetNodeId: "mid", type: EdgeType.DEPENDS_ON }),
      createEdgeRecord({ edgeId: "e2", sourceNodeId: "mid", targetNodeId: "leaf", type: EdgeType.DEPENDS_ON }),
    );

    blockFailedDependents(state);

    expect(state.nodes.get("mid")!.state).toBe(NodeState.BLOCKED);
    expect(state.nodes.get("leaf")!.state).toBe(NodeState.BLOCKED);
    expect(state.reservedTokens).toBe(0);
  });
});

// ── settleRun ────────────────────────────────────────────────────────────────

describe("settleRun", () => {
  it("all SUCCEEDED -> SUCCEEDED", () => {
    const state = baseState();
    state.nodes.set("a", makeNode({ nodeId: "a", state: NodeState.SUCCEEDED }));
    state.nodes.set("b", makeNode({ nodeId: "b", state: NodeState.SUCCEEDED }));
    settleRun(state);
    expect(state.status).toBe(RunStatus.SUCCEEDED);
  });

  it("a FAILED present (no READY/RUNNING) -> FAILED", () => {
    const state = baseState();
    state.nodes.set("a", makeNode({ nodeId: "a", state: NodeState.SUCCEEDED }));
    state.nodes.set("b", makeNode({ nodeId: "b", state: NodeState.FAILED }));
    settleRun(state);
    expect(state.status).toBe(RunStatus.FAILED);
  });

  it("a RUNNING present -> stays RUNNING (highest precedence)", () => {
    const state = baseState();
    state.nodes.set("a", makeNode({ nodeId: "a", state: NodeState.RUNNING }));
    state.nodes.set("b", makeNode({ nodeId: "b", state: NodeState.FAILED }));
    settleRun(state);
    expect(state.status).toBe(RunStatus.RUNNING);
  });

  it("a CANCELLED present (no READY/RUNNING) -> CANCELLED", () => {
    const state = baseState();
    state.nodes.set("a", makeNode({ nodeId: "a", state: NodeState.SUCCEEDED }));
    state.nodes.set("b", makeNode({ nodeId: "b", state: NodeState.CANCELLED }));
    settleRun(state);
    expect(state.status).toBe(RunStatus.CANCELLED);
  });

  it("BLOCKED present (no READY/RUNNING/CANCELLED) -> FAILED", () => {
    const state = baseState();
    state.nodes.set("a", makeNode({ nodeId: "a", state: NodeState.SUCCEEDED }));
    state.nodes.set("b", makeNode({ nodeId: "b", state: NodeState.BLOCKED }));
    settleRun(state);
    expect(state.status).toBe(RunStatus.FAILED);
  });
});

// ── cancelClaims ─────────────────────────────────────────────────────────────

describe("cancelClaims", () => {
  it("releases claimed executions and still-READY reservations, marks CANCELLED", () => {
    const state = baseState();
    addReadyNode(state, makeNode({ nodeId: "a" }), 100);
    addReadyNode(state, makeNode({ nodeId: "b" }), 200);
    const claims = freezeFrontierAndClaim(state);
    // add a still-READY node not claimed
    addReadyNode(state, makeNode({ nodeId: "c" }), 50);

    expect(state.reservedTokens).toBe(350);

    cancelClaims(state, claims);

    expect(state.nodes.get("a")!.state).toBe(NodeState.CANCELLED);
    expect(state.nodes.get("b")!.state).toBe(NodeState.CANCELLED);
    expect(state.nodes.get("c")!.state).toBe(NodeState.CANCELLED);
    expect(state.executions.get(claims[0]!.execution.executionId)!.state).toBe(
      ExecutionState.CANCELLED,
    );
    // all released, none committed
    expect(state.reservedTokens).toBe(0);
    expect(state.committedTokens).toBe(0);
    expect(state.nodeReservations.size).toBe(0);
    expect(state.status).toBe(RunStatus.CANCELLED);
  });
});
