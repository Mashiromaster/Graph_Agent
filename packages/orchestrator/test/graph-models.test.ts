import { describe, expect, it } from "vitest";
import {
  DecisionState,
  EdgeType,
  ExecutionState,
  NodeState,
  RunStatus,
  availableTokens,
  createBudgetSnapshot,
  createEdgeRecord,
  createExecutionRecord,
  createNodeRecord,
  createProposalDecision,
  runSnapshotFromDict,
  runSnapshotToDict,
} from "../src/graph-models.js";
import type { RunSnapshot } from "../src/graph-models.js";

describe("record factories", () => {
  it("createNodeRecord 冻结并保留字段", () => {
    const node = createNodeRecord({
      nodeId: "n1",
      name: "root",
      role: "planner",
      parentNodeId: null,
      generation: 0,
      priority: 0.5,
      state: NodeState.READY,
      allowedToolNames: ["a"],
      allocationTokens: 100,
    });
    expect(Object.isFrozen(node)).toBe(true);
    expect(node.state).toBe("ready");
    expect(node.allowedToolNames).toEqual(["a"]);
  });

  it("createEdgeRecord 应用默认值并冻结", () => {
    const edge = createEdgeRecord({
      edgeId: "e1",
      sourceNodeId: "n1",
      targetNodeId: "n2",
      type: EdgeType.DEPENDS_ON,
    });
    expect(Object.isFrozen(edge)).toBe(true);
    expect(edge.priority).toBe(0.5);
    expect(edge.weight).toBe(0.5);
    expect(edge.ttlSeconds).toBeNull();
    expect(edge.contentHash).toBeNull();
    expect(edge.type).toBe("depends_on");
  });

  it("createExecutionRecord 应用默认值并冻结", () => {
    const exec = createExecutionRecord({
      executionId: "x1",
      nodeId: "n1",
      sequence: 0,
      state: ExecutionState.QUEUED,
      reservedTokens: 10,
    });
    expect(Object.isFrozen(exec)).toBe(true);
    expect(exec.committedTokens).toBe(0);
    expect(exec.eventChainHead).toBeNull();
    expect(exec.state).toBe("queued");
  });

  it("createProposalDecision 应用默认值并冻结", () => {
    const decision = createProposalDecision({
      proposalId: "p1",
      proposalType: "spawn",
      sourceNodeId: "n1",
      state: DecisionState.ACCEPTED,
      code: "ok",
      message: "accepted",
    });
    expect(Object.isFrozen(decision)).toBe(true);
    expect(decision.materializedId).toBeNull();
    expect(decision.state).toBe("accepted");
  });

  it("createBudgetSnapshot 冻结, availableTokens 计算余额", () => {
    const budget = createBudgetSnapshot({
      limitTokens: 100,
      committedTokens: 30,
      reservedTokens: 20,
    });
    expect(Object.isFrozen(budget)).toBe(true);
    expect(availableTokens(budget)).toBe(50);
  });
});

function makeSnapshot(): RunSnapshot {
  return {
    runId: "run-1",
    status: RunStatus.RUNNING,
    nodes: [
      createNodeRecord({
        nodeId: "n1",
        name: "root",
        role: "planner",
        parentNodeId: null,
        generation: 0,
        priority: 0.5,
        state: NodeState.RUNNING,
        allowedToolNames: ["tool-a"],
        allocationTokens: 100,
      }),
    ],
    edges: [
      createEdgeRecord({
        edgeId: "e1",
        sourceNodeId: "n1",
        targetNodeId: "n2",
        type: EdgeType.SPAWN,
      }),
    ],
    executions: [
      createExecutionRecord({
        executionId: "x1",
        nodeId: "n1",
        sequence: 0,
        state: ExecutionState.RUNNING,
        reservedTokens: 10,
      }),
    ],
    decisions: [
      createProposalDecision({
        proposalId: "p1",
        proposalType: "spawn",
        sourceNodeId: "n1",
        state: DecisionState.ACCEPTED,
        code: "ok",
        message: "accepted",
      }),
    ],
    budget: createBudgetSnapshot({
      limitTokens: 100,
      committedTokens: 30,
      reservedTokens: 20,
    }),
    pendingExecutions: 1,
    superstep: 2,
  };
}

describe("runSnapshot round-trip", () => {
  it("toDict/fromDict 深度相等", () => {
    const snapshot = makeSnapshot();
    const dict = runSnapshotToDict(snapshot);
    const restored = runSnapshotFromDict(dict);
    expect(restored).toEqual(snapshot);
  });

  it("fromDict 冻结快照与嵌套数组", () => {
    const restored = runSnapshotFromDict(runSnapshotToDict(makeSnapshot()));
    expect(Object.isFrozen(restored)).toBe(true);
    expect(Object.isFrozen(restored.nodes)).toBe(true);
    expect(Object.isFrozen(restored.edges)).toBe(true);
  });

  it("fromDict 对未知枚举值 fail-closed", () => {
    const dict = runSnapshotToDict(makeSnapshot()) as Record<string, unknown>;
    (dict as { status: string }).status = "bogus";
    expect(() => runSnapshotFromDict(dict)).toThrow();
  });
});
