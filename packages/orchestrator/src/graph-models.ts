/**
 * 编排层图模型:枚举、记录接口、工厂函数与运行快照(可 canonicalJson 序列化)。
 *
 * 枚举以冻结的 const 对象 + 派生字符串联合类型建模,枚举值即线格式(wire format)。
 * 所有记录字段 readonly,工厂返回 `Object.freeze`。快照的 toDict/fromDict 可往返,
 * 且 fromDict 对未知枚举值 fail-closed(抛错)。
 */

// ── 枚举(const 对象 + 联合类型)──────────────────────────────────────────

export const RunStatus = Object.freeze({
  RUNNING: "running",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  CANCELLED: "cancelled",
} as const);
export type RunStatus = (typeof RunStatus)[keyof typeof RunStatus];

export const NodeState = Object.freeze({
  READY: "ready",
  BLOCKED: "blocked",
  RUNNING: "running",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  CANCELLED: "cancelled",
} as const);
export type NodeState = (typeof NodeState)[keyof typeof NodeState];

export const ExecutionState = Object.freeze({
  QUEUED: "queued",
  RUNNING: "running",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  CANCELLED: "cancelled",
} as const);
export type ExecutionState = (typeof ExecutionState)[keyof typeof ExecutionState];

export const DecisionState = Object.freeze({
  ACCEPTED: "accepted",
  REJECTED: "rejected",
} as const);
export type DecisionState = (typeof DecisionState)[keyof typeof DecisionState];

export const EdgeType = Object.freeze({
  SPAWN: "spawn",
  DEPENDS_ON: "depends_on",
  MESSAGE: "message",
  SKIP_CONTEXT: "skip_context",
} as const);
export type EdgeType = (typeof EdgeType)[keyof typeof EdgeType];

function assertMember<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new RangeError(`${label} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

const RUN_STATUS_VALUES = Object.values(RunStatus);
const NODE_STATE_VALUES = Object.values(NodeState);
const EXECUTION_STATE_VALUES = Object.values(ExecutionState);
const DECISION_STATE_VALUES = Object.values(DecisionState);
const EDGE_TYPE_VALUES = Object.values(EdgeType);

// ── 记录接口 ─────────────────────────────────────────────────────────────

export interface NodeRecord {
  readonly nodeId: string;
  readonly name: string;
  readonly role: string;
  readonly parentNodeId: string | null;
  readonly generation: number;
  readonly priority: number;
  readonly state: NodeState;
  readonly allowedToolNames: readonly string[];
  readonly allocationTokens: number;
  /**
   * 该节点绑定的模型类型;`null` 表示未指定(由 NodeFactory 自行决定)。
   * 持久化到 checkpoint 以保证异质图 resume 后能重建同样的模型绑定。
   */
  readonly modelKind: string | null;
}

export interface EdgeRecord {
  readonly edgeId: string;
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly type: EdgeType;
  readonly priority: number;
  readonly weight: number;
  readonly ttlSeconds: number | null;
  readonly contentHash: string | null;
}

export interface ExecutionRecord {
  readonly executionId: string;
  readonly nodeId: string;
  readonly sequence: number;
  readonly state: ExecutionState;
  readonly reservedTokens: number;
  readonly committedTokens: number;
  readonly eventChainHead: string | null;
}

export interface ProposalDecision {
  readonly proposalId: string;
  readonly proposalType: string;
  readonly sourceNodeId: string;
  readonly state: DecisionState;
  readonly code: string;
  readonly message: string;
  readonly materializedId: string | null;
}

export interface BudgetSnapshot {
  readonly limitTokens: number;
  readonly committedTokens: number;
  readonly reservedTokens: number;
}

// ── 工厂函数 ─────────────────────────────────────────────────────────────

export function createNodeRecord(input: {
  nodeId: string;
  name: string;
  role: string;
  parentNodeId: string | null;
  generation: number;
  priority: number;
  state: NodeState;
  allowedToolNames: readonly string[];
  allocationTokens: number;
  modelKind?: string | null;
}): NodeRecord {
  return Object.freeze({
    nodeId: input.nodeId,
    name: input.name,
    role: input.role,
    parentNodeId: input.parentNodeId,
    generation: input.generation,
    priority: input.priority,
    state: assertMember(input.state, NODE_STATE_VALUES, "state"),
    allowedToolNames: Object.freeze([...input.allowedToolNames]),
    allocationTokens: input.allocationTokens,
    modelKind: input.modelKind ?? null,
  });
}

export function createEdgeRecord(input: {
  edgeId: string;
  sourceNodeId: string;
  targetNodeId: string;
  type: EdgeType;
  priority?: number;
  weight?: number;
  ttlSeconds?: number | null;
  contentHash?: string | null;
}): EdgeRecord {
  return Object.freeze({
    edgeId: input.edgeId,
    sourceNodeId: input.sourceNodeId,
    targetNodeId: input.targetNodeId,
    type: assertMember(input.type, EDGE_TYPE_VALUES, "type"),
    priority: input.priority ?? 0.5,
    weight: input.weight ?? 0.5,
    ttlSeconds: input.ttlSeconds ?? null,
    contentHash: input.contentHash ?? null,
  });
}

export function createExecutionRecord(input: {
  executionId: string;
  nodeId: string;
  sequence: number;
  state: ExecutionState;
  reservedTokens: number;
  committedTokens?: number;
  eventChainHead?: string | null;
}): ExecutionRecord {
  return Object.freeze({
    executionId: input.executionId,
    nodeId: input.nodeId,
    sequence: input.sequence,
    state: assertMember(input.state, EXECUTION_STATE_VALUES, "state"),
    reservedTokens: input.reservedTokens,
    committedTokens: input.committedTokens ?? 0,
    eventChainHead: input.eventChainHead ?? null,
  });
}

export function createProposalDecision(input: {
  proposalId: string;
  proposalType: string;
  sourceNodeId: string;
  state: DecisionState;
  code: string;
  message: string;
  materializedId?: string | null;
}): ProposalDecision {
  return Object.freeze({
    proposalId: input.proposalId,
    proposalType: input.proposalType,
    sourceNodeId: input.sourceNodeId,
    state: assertMember(input.state, DECISION_STATE_VALUES, "state"),
    code: input.code,
    message: input.message,
    materializedId: input.materializedId ?? null,
  });
}

export function createBudgetSnapshot(input: {
  limitTokens: number;
  committedTokens: number;
  reservedTokens: number;
}): BudgetSnapshot {
  return Object.freeze({
    limitTokens: input.limitTokens,
    committedTokens: input.committedTokens,
    reservedTokens: input.reservedTokens,
  });
}

export function availableTokens(budget: BudgetSnapshot): number {
  return budget.limitTokens - budget.committedTokens - budget.reservedTokens;
}

// ── 运行快照 ─────────────────────────────────────────────────────────────

export interface RunSnapshot {
  readonly runId: string;
  readonly status: RunStatus;
  readonly nodes: readonly NodeRecord[];
  readonly edges: readonly EdgeRecord[];
  readonly executions: readonly ExecutionRecord[];
  readonly decisions: readonly ProposalDecision[];
  readonly budget: BudgetSnapshot;
  readonly pendingExecutions: number;
  readonly superstep: number;
}

/** 将快照转为可 canonicalJson 序列化的普通对象(枚举值已是字符串,数组浅拷贝)。 */
export function runSnapshotToDict(snapshot: RunSnapshot): Record<string, unknown> {
  return {
    runId: snapshot.runId,
    status: snapshot.status,
    nodes: snapshot.nodes.map((node) => ({
      nodeId: node.nodeId,
      name: node.name,
      role: node.role,
      parentNodeId: node.parentNodeId,
      generation: node.generation,
      priority: node.priority,
      state: node.state,
      allowedToolNames: [...node.allowedToolNames],
      allocationTokens: node.allocationTokens,
      // modelKind 为 null 时整键省略:同质图(既有行为)的 canonicalJson 与
      // stateDigest 因此逐字节不变,v1/v2 旧 checkpoint 仍可通过 digest 复算。
      ...(node.modelKind !== null ? { modelKind: node.modelKind } : {}),
    })),
    edges: snapshot.edges.map((edge) => ({
      edgeId: edge.edgeId,
      sourceNodeId: edge.sourceNodeId,
      targetNodeId: edge.targetNodeId,
      type: edge.type,
      priority: edge.priority,
      weight: edge.weight,
      ttlSeconds: edge.ttlSeconds,
      contentHash: edge.contentHash,
    })),
    executions: snapshot.executions.map((exec) => ({
      executionId: exec.executionId,
      nodeId: exec.nodeId,
      sequence: exec.sequence,
      state: exec.state,
      reservedTokens: exec.reservedTokens,
      committedTokens: exec.committedTokens,
      eventChainHead: exec.eventChainHead,
    })),
    decisions: snapshot.decisions.map((decision) => ({
      proposalId: decision.proposalId,
      proposalType: decision.proposalType,
      sourceNodeId: decision.sourceNodeId,
      state: decision.state,
      code: decision.code,
      message: decision.message,
      materializedId: decision.materializedId,
    })),
    budget: {
      limitTokens: snapshot.budget.limitTokens,
      committedTokens: snapshot.budget.committedTokens,
      reservedTokens: snapshot.budget.reservedTokens,
    },
    pendingExecutions: snapshot.pendingExecutions,
    superstep: snapshot.superstep,
  };
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  return value;
}

/** 由普通对象重建快照,校验枚举成员,未知枚举值 fail-closed。冻结返回值及嵌套数组。 */
export function runSnapshotFromDict(dict: unknown): RunSnapshot {
  const root = asRecord(dict, "runSnapshot");
  const budget = asRecord(root["budget"], "budget");

  const nodes = Object.freeze(
    asArray(root["nodes"], "nodes").map((raw) => {
      const node = asRecord(raw, "node");
      return createNodeRecord({
        nodeId: node["nodeId"] as string,
        name: node["name"] as string,
        role: node["role"] as string,
        parentNodeId: (node["parentNodeId"] as string | null) ?? null,
        generation: node["generation"] as number,
        priority: node["priority"] as number,
        state: assertMember(node["state"], NODE_STATE_VALUES, "state"),
        allowedToolNames: asArray(
          node["allowedToolNames"],
          "allowedToolNames",
        ) as string[],
        allocationTokens: node["allocationTokens"] as number,
        modelKind: (node["modelKind"] as string | undefined) ?? null,
      });
    }),
  );

  const edges = Object.freeze(
    asArray(root["edges"], "edges").map((raw) => {
      const edge = asRecord(raw, "edge");
      return createEdgeRecord({
        edgeId: edge["edgeId"] as string,
        sourceNodeId: edge["sourceNodeId"] as string,
        targetNodeId: edge["targetNodeId"] as string,
        type: assertMember(edge["type"], EDGE_TYPE_VALUES, "type"),
        priority: edge["priority"] as number,
        weight: edge["weight"] as number,
        ttlSeconds: (edge["ttlSeconds"] as number | null) ?? null,
        contentHash: (edge["contentHash"] as string | null) ?? null,
      });
    }),
  );

  const executions = Object.freeze(
    asArray(root["executions"], "executions").map((raw) => {
      const exec = asRecord(raw, "execution");
      return createExecutionRecord({
        executionId: exec["executionId"] as string,
        nodeId: exec["nodeId"] as string,
        sequence: exec["sequence"] as number,
        state: assertMember(exec["state"], EXECUTION_STATE_VALUES, "state"),
        reservedTokens: exec["reservedTokens"] as number,
        committedTokens: exec["committedTokens"] as number,
        eventChainHead: (exec["eventChainHead"] as string | null) ?? null,
      });
    }),
  );

  const decisions = Object.freeze(
    asArray(root["decisions"], "decisions").map((raw) => {
      const decision = asRecord(raw, "decision");
      return createProposalDecision({
        proposalId: decision["proposalId"] as string,
        proposalType: decision["proposalType"] as string,
        sourceNodeId: decision["sourceNodeId"] as string,
        state: assertMember(decision["state"], DECISION_STATE_VALUES, "state"),
        code: decision["code"] as string,
        message: decision["message"] as string,
        materializedId: (decision["materializedId"] as string | null) ?? null,
      });
    }),
  );

  return Object.freeze({
    runId: root["runId"] as string,
    status: assertMember(root["status"], RUN_STATUS_VALUES, "status"),
    nodes,
    edges,
    executions,
    decisions,
    budget: createBudgetSnapshot({
      limitTokens: budget["limitTokens"] as number,
      committedTokens: budget["committedTokens"] as number,
      reservedTokens: budget["reservedTokens"] as number,
    }),
    pendingExecutions: root["pendingExecutions"] as number,
    superstep: root["superstep"] as number,
  });
}
