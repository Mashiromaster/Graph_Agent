import { describe, expect, it } from "vitest";
import {
  createMessageProposal,
  createSkipContextProposal,
  createSpawnProposal,
  createAgentResult,
  createUsage,
  NodeStatus,
  type AgentInput,
  type AgentResult,
} from "@graph-agent/core";
import { createControllerPolicy } from "../src/policy.js";
import {
  createMutableRunState,
  type MutableRunState,
} from "../src/mutable-state.js";
import {
  createNodeRecord,
  DecisionState,
  EdgeType,
  NodeState,
  type NodeRecord,
} from "../src/graph-models.js";
import { applyMessage, applySkip, applySpawn } from "../src/mutations.js";
import {
  RunnerCancelledError,
  type AgentSpec,
  type NodeFactory,
  type NodeRunner,
} from "../src/runner.js";

const RUN_ID = "run-1";

/** A fake runner whose run() never actually executes in these tests. */
function stubRunner(spec: AgentSpec): NodeRunner {
  return {
    spec,
    async run(_input: AgentInput): Promise<AgentResult> {
      return createAgentResult({
        nodeId: spec.identity.nodeId,
        status: NodeStatus.COMPLETED,
        output: "ok",
        usage: createUsage(),
        events: [],
      });
    },
  };
}

/** Factory that records how many times create() was invoked. */
function stubFactory(): NodeFactory & { calls: number } {
  return {
    calls: 0,
    create(args: { spec: AgentSpec; toolNames: readonly string[] }): NodeRunner {
      this.calls += 1;
      return stubRunner(args.spec);
    },
  };
}

/** Factory that throws to exercise FACTORY_ERROR. */
function throwingFactory(): NodeFactory {
  return {
    create(): NodeRunner {
      throw new Error("boom");
    },
  };
}

/** Build a state with a root node holding `allocation` tokens, reserved. */
function stateWithRoot(
  allocation: number,
  rootTools: readonly string[] = ["a", "b"],
  policyOverrides = {},
): { state: MutableRunState; root: NodeRecord } {
  const policy = createControllerPolicy({ maxTotalTokens: 10000, ...policyOverrides });
  const state = createMutableRunState(RUN_ID, policy);
  const root = createNodeRecord({
    nodeId: "root",
    name: "Root Agent",
    role: "root",
    parentNodeId: null,
    generation: 0,
    priority: 0.5,
    state: NodeState.RUNNING,
    allowedToolNames: rootTools,
    allocationTokens: allocation,
  });
  state.nodes.set(root.nodeId, root);
  state.nodeReservations.set(root.nodeId, allocation);
  state.reservedTokens += allocation;
  return { state, root };
}

function spawn(overrides = {}) {
  return createSpawnProposal({
    proposalId: "p1",
    parentNodeId: "root",
    generation: 1,
    role: "worker",
    objective: "do the thing",
    instructions: "instructions here",
    toolNames: ["a"],
    priority: 0.5,
    budgetShare: 0.5,
    ...overrides,
  });
}

describe("applySpawn", () => {
  it("materializes a READY child, reservation, and SPAWN edge; returns ACCEPTED", () => {
    const { state, root } = stateWithRoot(1000);
    const factory = stubFactory();
    const beforeReserved = state.reservedTokens;

    const decision = applySpawn(state, root, spawn(), 0, factory, RUN_ID);

    expect(decision.state).toBe(DecisionState.ACCEPTED);
    expect(decision.materializedId).not.toBeNull();
    const childId = decision.materializedId!;
    expect(factory.calls).toBe(1);

    const child = state.nodes.get(childId);
    expect(child).toBeDefined();
    expect(child!.state).toBe(NodeState.READY);
    expect(child!.generation).toBe(root.generation + 1);
    expect(child!.allocationTokens).toBe(500); // floor(1000 * 0.5)
    expect(child!.allocationTokens).toBeGreaterThanOrEqual(1);

    expect(state.nodeReservations.get(childId)).toBe(500);
    expect(state.reservedTokens).toBe(beforeReserved + 500);
    expect(state.specs.has(childId)).toBe(true);
    expect(state.runners.has(childId)).toBe(true);
    expect(state.inputs.has(childId)).toBe(true);

    const edge = state.edges.find((e) => e.targetNodeId === childId);
    expect(edge).toBeDefined();
    expect(edge!.type).toBe(EdgeType.SPAWN);
    expect(edge!.sourceNodeId).toBe("root");
  });

  it("child input carries a SPAWN-edge context packet from the parent", () => {
    const { state, root } = stateWithRoot(1000);
    const decision = applySpawn(state, root, spawn(), 0, stubFactory(), RUN_ID);
    const input = state.inputs.get(decision.materializedId!) as AgentInput;
    expect(input.context.length).toBe(1);
    expect(input.context[0]!.sourceNodeId).toBe("root");
    expect(input.context[0]!.edgeType).toBe(EdgeType.SPAWN);
  });

  it("allocation floors to at least 1 for a tiny share", () => {
    const { state, root } = stateWithRoot(1);
    const decision = applySpawn(
      state,
      root,
      spawn({ budgetShare: 0.1 }),
      0,
      stubFactory(),
      RUN_ID,
    );
    expect(decision.state).toBe(DecisionState.ACCEPTED);
    expect(state.nodes.get(decision.materializedId!)!.allocationTokens).toBe(1);
  });

  it("rejects a duplicate (same ordinal + proposalId) with DUPLICATE_PROPOSAL", () => {
    const { state, root } = stateWithRoot(1000);
    const first = applySpawn(state, root, spawn(), 0, stubFactory(), RUN_ID);
    expect(first.state).toBe(DecisionState.ACCEPTED);
    const nodesAfterFirst = state.nodes.size;

    const second = applySpawn(state, root, spawn(), 0, stubFactory(), RUN_ID);
    expect(second.state).toBe(DecisionState.REJECTED);
    expect(second.code).toBe("DUPLICATE_PROPOSAL");
    expect(state.nodes.size).toBe(nodesAfterFirst);
  });

  it("rejects when allocation exceeds available budget (TOKEN_BUDGET_EXHAUSTED)", () => {
    // root allocation huge, but global maxTotalTokens tiny → allocation > available.
    const { state, root } = stateWithRoot(1000, ["a", "b"], { maxTotalTokens: 1200 });
    // available = 1200 - 0 - 1000(root reservation) = 200; allocation = floor(1000*0.5)=500 > 200
    const decision = applySpawn(state, root, spawn(), 0, stubFactory(), RUN_ID);
    expect(decision.state).toBe(DecisionState.REJECTED);
    expect(decision.code).toBe("TOKEN_BUDGET_EXHAUSTED");
    expect(state.nodes.size).toBe(1); // only root
  });

  it("rejects with FACTORY_ERROR when the factory throws; no node/reservation leaked", () => {
    const { state, root } = stateWithRoot(1000);
    const beforeReserved = state.reservedTokens;
    const decision = applySpawn(state, root, spawn(), 0, throwingFactory(), RUN_ID);
    expect(decision.state).toBe(DecisionState.REJECTED);
    expect(decision.code).toBe("FACTORY_ERROR");
    expect(state.nodes.size).toBe(1);
    expect(state.reservedTokens).toBe(beforeReserved);
    expect(state.edges.length).toBe(0);
  });

  it("propagates a validateSpawn rejection code (e.g. GENERATION_MISMATCH)", () => {
    const { state, root } = stateWithRoot(1000);
    const decision = applySpawn(
      state,
      root,
      spawn({ generation: 5 }),
      0,
      stubFactory(),
      RUN_ID,
    );
    expect(decision.state).toBe(DecisionState.REJECTED);
    expect(decision.code).toBe("GENERATION_MISMATCH");
    expect(state.nodes.size).toBe(1);
  });
});

describe("applyMessage", () => {
  function twoNodeState() {
    const { state, root } = stateWithRoot(1000);
    const other = createNodeRecord({
      nodeId: "other",
      name: "Other",
      role: "worker",
      parentNodeId: "root",
      generation: 1,
      priority: 0.5,
      state: NodeState.READY,
      allowedToolNames: ["a"],
      allocationTokens: 100,
    });
    state.nodes.set(other.nodeId, other);
    return { state, root, other };
  }

  it("materializes a MESSAGE edge; returns ACCEPTED", () => {
    const { state, root } = twoNodeState();
    const proposal = createMessageProposal({
      proposalId: "m1",
      sourceNodeId: "root",
      targetNodeId: "other",
      content: "hello",
      ttlSeconds: 60,
    });
    const decision = applyMessage(state, root, proposal, RUN_ID);
    expect(decision.state).toBe(DecisionState.ACCEPTED);
    const edge = state.edges.find((e) => e.edgeId === decision.materializedId);
    expect(edge).toBeDefined();
    expect(edge!.type).toBe(EdgeType.MESSAGE);
    expect(edge!.ttlSeconds).toBe(60);
    expect(edge!.contentHash).not.toBeNull();
  });

  it("rejects an unknown target with TARGET_NOT_FOUND", () => {
    const { state, root } = twoNodeState();
    const proposal = createMessageProposal({
      proposalId: "m2",
      sourceNodeId: "root",
      targetNodeId: "ghost",
      content: "hello",
    });
    const decision = applyMessage(state, root, proposal, RUN_ID);
    expect(decision.state).toBe(DecisionState.REJECTED);
    expect(decision.code).toBe("TARGET_NOT_FOUND");
  });

  it("rejects a self-edge with SELF_EDGE", () => {
    const { state, root } = twoNodeState();
    const proposal = createMessageProposal({
      proposalId: "m3",
      sourceNodeId: "root",
      targetNodeId: "root",
      content: "hello",
    });
    const decision = applyMessage(state, root, proposal, RUN_ID);
    expect(decision.state).toBe(DecisionState.REJECTED);
    expect(decision.code).toBe("SELF_EDGE");
  });

  it("buffers the plaintext for the target while the edge keeps only a hash", () => {
    // 这是 claim (c) 的基础:在此之前明文被丢弃,消息边只剩 sha256,
    // 「通讯」在可观测意义上是 no-op。
    const { state, root } = twoNodeState();
    const proposal = createMessageProposal({
      proposalId: "m4",
      sourceNodeId: "root",
      targetNodeId: "other",
      content: "the shared finding",
      priority: 0.75,
      ttlSeconds: 60,
    });
    const decision = applyMessage(state, root, proposal, RUN_ID);
    expect(decision.state).toBe(DecisionState.ACCEPTED);

    const buffered = state.pendingDeliveries.get("other");
    expect(buffered).toHaveLength(1);
    expect(buffered![0]!.content).toBe("the shared finding");
    expect(buffered![0]!.sourceNodeId).toBe("root");
    expect(buffered![0]!.priority).toBe(0.75);
    expect(buffered![0]!.kind).toBe(EdgeType.MESSAGE);
    expect(buffered![0]!.mandatory).toBe(false);

    // 边上仍只有摘要,审计口径不变(明文不进快照)。
    const edge = state.edges.find((e) => e.edgeId === decision.materializedId)!;
    expect(edge.contentHash).not.toBeNull();
    expect(JSON.stringify(edge)).not.toContain("the shared finding");
  });

  it("rejects a message to a node that already ran with TARGET_ALREADY_EXECUTED", () => {
    // 节点只执行一次且永不重入,故向非 READY 节点投递不可能影响任何输出。
    // 此前这类提案被静默接受并留一条惰性边,使无效通讯看起来成功。
    for (const state_ of [NodeState.RUNNING, NodeState.SUCCEEDED, NodeState.FAILED]) {
      const { state, root, other } = twoNodeState();
      state.nodes.set(
        other.nodeId,
        createNodeRecord({
          nodeId: other.nodeId,
          name: other.name,
          role: other.role,
          parentNodeId: other.parentNodeId,
          generation: other.generation,
          priority: other.priority,
          state: state_,
          allowedToolNames: other.allowedToolNames,
          allocationTokens: other.allocationTokens,
        }),
      );
      const decision = applyMessage(
        state,
        root,
        createMessageProposal({
          proposalId: "m5",
          sourceNodeId: "root",
          targetNodeId: "other",
          content: "too late",
        }),
        RUN_ID,
      );
      expect(decision.state).toBe(DecisionState.REJECTED);
      expect(decision.code).toBe("TARGET_ALREADY_EXECUTED");
      expect(state.pendingDeliveries.get("other")).toBeUndefined();
    }
  });
});

describe("applySkip", () => {
  function ancestorState() {
    const { state, root } = stateWithRoot(1000);
    const child = createNodeRecord({
      nodeId: "child",
      name: "Child",
      role: "worker",
      parentNodeId: "root",
      generation: 1,
      priority: 0.5,
      state: NodeState.READY,
      allowedToolNames: ["a"],
      allocationTokens: 100,
    });
    state.nodes.set(child.nodeId, child);
    return { state, root, child };
  }

  it("materializes a SKIP_CONTEXT edge from ancestor to requester; ACCEPTED", () => {
    const { state, child } = ancestorState();
    const proposal = createSkipContextProposal({
      proposalId: "s1",
      requesterNodeId: "child",
      sourceNodeId: "root",
      reason: "already have it",
      contextGate: 0.3,
    });
    const decision = applySkip(state, child, proposal, RUN_ID);
    expect(decision.state).toBe(DecisionState.ACCEPTED);
    const edge = state.edges.find((e) => e.edgeId === decision.materializedId);
    expect(edge).toBeDefined();
    expect(edge!.type).toBe(EdgeType.SKIP_CONTEXT);
    expect(edge!.sourceNodeId).toBe("root");
    expect(edge!.targetNodeId).toBe("child");
    expect(edge!.weight).toBe(0.3);
    expect(edge!.contentHash).not.toBeNull();
  });

  it("rejects a non-ancestor source with POLICY_DENIED", () => {
    const { state, root } = ancestorState();
    // root requesting skip from child: child is NOT an ancestor of root.
    const proposal = createSkipContextProposal({
      proposalId: "s2",
      requesterNodeId: "root",
      sourceNodeId: "child",
      reason: "nope",
    });
    const decision = applySkip(state, root, proposal, RUN_ID);
    expect(decision.state).toBe(DecisionState.REJECTED);
    expect(decision.code).toBe("POLICY_DENIED");
  });
});

describe("RunnerCancelledError", () => {
  it("is an Error with its own name", () => {
    const err = new RunnerCancelledError("cancelled");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("RunnerCancelledError");
    expect(err.message).toBe("cancelled");
  });
});
