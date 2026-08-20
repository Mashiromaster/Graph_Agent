import { describe, expect, it } from "vitest";
import { createControllerPolicy } from "../src/policy.js";
import {
  createMutableRunState,
  snapshotOf,
} from "../src/mutable-state.js";
import { validateSnapshot } from "../src/snapshot-validation.js";
import {
  ExecutionState,
  NodeState,
  RunStatus,
  createBudgetSnapshot,
  createEdgeRecord,
  createExecutionRecord,
  createNodeRecord,
} from "../src/graph-models.js";
import type { RunSnapshot } from "../src/graph-models.js";

const POLICY = createControllerPolicy({ maxTotalTokens: 1000 });

function node(nodeId: string, state = NodeState.READY) {
  return createNodeRecord({
    nodeId,
    name: nodeId,
    role: "worker",
    parentNodeId: null,
    generation: 0,
    priority: 0.5,
    state,
    allowedToolNames: [],
    allocationTokens: 0,
  });
}

function wellFormed(): RunSnapshot {
  const state = createMutableRunState("run-1", POLICY);
  state.nodes.set("a", node("a", NodeState.READY));
  state.nodes.set("b", node("b", NodeState.SUCCEEDED));
  return snapshotOf(state);
}

describe("createMutableRunState", () => {
  it("默认 RUNNING、空集合、计数归零", () => {
    const state = createMutableRunState("run-1", POLICY);
    expect(state.runId).toBe("run-1");
    expect(state.status).toBe(RunStatus.RUNNING);
    expect(state.nodes.size).toBe(0);
    expect(state.edges.length).toBe(0);
    expect(state.executions.size).toBe(0);
    expect(state.decisions.length).toBe(0);
    expect(state.committedTokens).toBe(0);
    expect(state.reservedTokens).toBe(0);
    expect(state.enqueueSequence).toBe(0);
    expect(state.superstep).toBe(0);
  });
});

describe("snapshotOf", () => {
  it("pendingExecutions 仅计 READY|RUNNING 节点", () => {
    const state = createMutableRunState("run-1", POLICY);
    state.nodes.set("a", node("a", NodeState.READY));
    state.nodes.set("b", node("b", NodeState.SUCCEEDED));
    state.nodes.set("c", node("c", NodeState.RUNNING));
    const snap = snapshotOf(state);
    expect(snap.pendingExecutions).toBe(2);
  });

  it("快照与嵌套数组均被冻结", () => {
    const snap = wellFormed();
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.nodes)).toBe(true);
    expect(Object.isFrozen(snap.edges)).toBe(true);
    expect(Object.isFrozen(snap.executions)).toBe(true);
    expect(Object.isFrozen(snap.decisions)).toBe(true);
  });

  it("节点按 nodeId 确定性排序", () => {
    const state = createMutableRunState("run-1", POLICY);
    state.nodes.set("z", node("z"));
    state.nodes.set("a", node("a"));
    state.nodes.set("m", node("m"));
    const snap = snapshotOf(state);
    expect(snap.nodes.map((n) => n.nodeId)).toEqual(["a", "m", "z"]);
  });

  it("budget 反映 committed/reserved 与 limit", () => {
    const state = createMutableRunState("run-1", POLICY);
    state.committedTokens = 100;
    state.reservedTokens = 50;
    const snap = snapshotOf(state);
    expect(snap.budget.limitTokens).toBe(1000);
    expect(snap.budget.committedTokens).toBe(100);
    expect(snap.budget.reservedTokens).toBe(50);
  });
});

describe("validateSnapshot", () => {
  it("良构快照返回 null", () => {
    expect(validateSnapshot(wellFormed(), "run-1")).toBeNull();
  });

  it("runId 不匹配 → RUN_ID_MISMATCH", () => {
    expect(validateSnapshot(wellFormed(), "other")).toBe("RUN_ID_MISMATCH");
  });

  it("runId 为空 → RUN_ID_MISMATCH", () => {
    const state = createMutableRunState("", POLICY);
    expect(validateSnapshot(snapshotOf(state), "")).toBe("RUN_ID_MISMATCH");
  });

  it("重复 node id → DUPLICATE_NODE_ID", () => {
    const base = wellFormed();
    const snap: RunSnapshot = {
      ...base,
      nodes: [base.nodes[0]!, base.nodes[0]!],
    };
    expect(validateSnapshot(snap, "run-1")).toBe("DUPLICATE_NODE_ID");
  });

  it("空 node id → INVALID_NODE_ID", () => {
    const base = wellFormed();
    const snap: RunSnapshot = {
      ...base,
      nodes: [node(""), base.nodes[0]!],
    };
    expect(validateSnapshot(snap, "run-1")).toBe("INVALID_NODE_ID");
  });

  it("边指向未知节点 → DANGLING_EDGE", () => {
    const base = wellFormed();
    const snap: RunSnapshot = {
      ...base,
      edges: [
        createEdgeRecord({
          edgeId: "e1",
          sourceNodeId: "a",
          targetNodeId: "ghost",
          type: "depends_on",
        }),
      ],
    };
    expect(validateSnapshot(snap, "run-1")).toBe("DANGLING_EDGE");
  });

  it("重复 edge id → DUPLICATE_EDGE_ID", () => {
    const base = wellFormed();
    const edge = createEdgeRecord({
      edgeId: "e1",
      sourceNodeId: "a",
      targetNodeId: "b",
      type: "depends_on",
    });
    const snap: RunSnapshot = { ...base, edges: [edge, edge] };
    expect(validateSnapshot(snap, "run-1")).toBe("DUPLICATE_EDGE_ID");
  });

  it("执行 nodeId 未知 → DANGLING_EXECUTION", () => {
    const base = wellFormed();
    const snap: RunSnapshot = {
      ...base,
      executions: [
        createExecutionRecord({
          executionId: "x1",
          nodeId: "ghost",
          sequence: 0,
          state: ExecutionState.SUCCEEDED,
          reservedTokens: 10,
          committedTokens: 5,
        }),
      ],
    };
    expect(validateSnapshot(snap, "run-1")).toBe("DANGLING_EXECUTION");
  });

  it("重复 execution id → DUPLICATE_EXECUTION_ID", () => {
    const base = wellFormed();
    const exec = createExecutionRecord({
      executionId: "x1",
      nodeId: "a",
      sequence: 0,
      state: ExecutionState.SUCCEEDED,
      reservedTokens: 10,
      committedTokens: 5,
    });
    const snap: RunSnapshot = { ...base, executions: [exec, exec] };
    expect(validateSnapshot(snap, "run-1")).toBe("DUPLICATE_EXECUTION_ID");
  });

  it("预算超限 → INVALID_BUDGET", () => {
    const base = wellFormed();
    const snap: RunSnapshot = {
      ...base,
      budget: createBudgetSnapshot({
        limitTokens: 100,
        committedTokens: 80,
        reservedTokens: 40,
      }),
    };
    expect(validateSnapshot(snap, "run-1")).toBe("INVALID_BUDGET");
  });

  it("单执行 committed>reserved → INVALID_EXECUTION_BUDGET", () => {
    const base = wellFormed();
    const snap: RunSnapshot = {
      ...base,
      executions: [
        createExecutionRecord({
          executionId: "x1",
          nodeId: "a",
          sequence: 0,
          state: ExecutionState.SUCCEEDED,
          reservedTokens: 10,
          committedTokens: 20,
        }),
      ],
    };
    expect(validateSnapshot(snap, "run-1")).toBe("INVALID_EXECUTION_BUDGET");
  });

  it("pendingExecutions 与实际不符 → PENDING_MISMATCH", () => {
    const base = wellFormed();
    const snap: RunSnapshot = { ...base, pendingExecutions: 99 };
    expect(validateSnapshot(snap, "run-1")).toBe("PENDING_MISMATCH");
  });

  it("superstep 为负 → INVALID_SUPERSTEP", () => {
    const base = wellFormed();
    const snap: RunSnapshot = { ...base, superstep: -1 };
    expect(validateSnapshot(snap, "run-1")).toBe("INVALID_SUPERSTEP");
  });

  it("SUCCEEDED 状态但有非 SUCCEEDED 节点 → INCONSISTENT_STATUS", () => {
    const state = createMutableRunState("run-1", POLICY);
    // FAILED 节点不计入 pending,pendingExecutions=0 与状态一致,
    // 从而隔离出「SUCCEEDED 状态下存在非 SUCCEEDED 节点」这一条不变量。
    state.nodes.set("a", node("a", NodeState.FAILED));
    state.status = RunStatus.SUCCEEDED;
    const snap = snapshotOf(state);
    expect(snap.pendingExecutions).toBe(0);
    expect(validateSnapshot(snap, "run-1")).toBe("INCONSISTENT_STATUS");
  });

  it("非 RUNNING 状态但有 pending → INCONSISTENT_STATUS", () => {
    const state = createMutableRunState("run-1", POLICY);
    state.nodes.set("a", node("a", NodeState.READY));
    state.status = RunStatus.FAILED;
    const snap = snapshotOf(state); // pendingExecutions = 1
    expect(validateSnapshot(snap, "run-1")).toBe("INCONSISTENT_STATUS");
  });
});
