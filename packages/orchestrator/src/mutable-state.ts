/**
 * 可变运行状态:控制器持有的唯一可变对象,及其冻结快照的生成。
 *
 * `MutableRunState` 是编排层里唯一字段可变的结构——控制器的私有状态。它的
 * 集合(Map/数组)与标量字段允许原地修改,但其中的记录(NodeRecord 等)本身
 * 仍不可变:更新时应「替换」记录而非原地改字段。
 *
 * `snapshotOf` 将可变状态投影为一份完全冻结、确定性排序的 `RunSnapshot`,
 * 供事件链、持久化与 replay 再校验消费。确定性:无 Date/random,数组按
 * 稳定键排序。
 *
 * 关于 specs/runners/inputs:为避免对 Task 7 的 runner.ts 产生前向依赖,
 * 这里将三者统一建模为 `Map<string, unknown>`。Task 7 引入具体的
 * NodeRunner/AgentSpec/AgentInput 类型后可收窄读取处的类型,无需改动本结构。
 */

import {
  NodeState,
  RunStatus,
  createBudgetSnapshot,
} from "./graph-models.js";
import type {
  EdgeRecord,
  ExecutionRecord,
  NodeRecord,
  ProposalDecision,
  RunSnapshot,
} from "./graph-models.js";
import type { ControllerPolicy } from "./policy.js";
import type { AgentResult } from "@graph-agent/core";

/**
 * 控制器持有的唯一可变状态。字段可变(非 readonly),集合原地增删;
 * 其中的记录值保持不可变——更新以替换整条记录的方式进行。
 */
export interface MutableRunState {
  runId: string;
  status: RunStatus;
  policy: ControllerPolicy;
  nodes: Map<string, NodeRecord>;
  /** 见文件头:Task 7 前统一为 unknown 占位,避免前向依赖。 */
  specs: Map<string, unknown>;
  /** 见文件头:Task 7 前统一为 unknown 占位。 */
  runners: Map<string, unknown>;
  /** 见文件头:Task 7 前统一为 unknown 占位(实际承载 core 的 AgentInput)。 */
  inputs: Map<string, unknown>;
  edges: EdgeRecord[];
  executions: Map<string, ExecutionRecord>;
  decisions: ProposalDecision[];
  processedResults: Map<string, readonly ProposalDecision[]>;
  /**
   * 每次带真实结果结算的 AgentResult 归档,键为 executionId。纯增字段:
   * 仅供 v2 resumable checkpoint 携带已完成执行的产物以支持 resume;
   * snapshotOf 不投影它,SP1-4 的一切既有行为不受影响。
   */
  archivedResults: Map<string, AgentResult>;
  nodeReservations: Map<string, number>;
  committedTokens: number;
  reservedTokens: number;
  enqueueSequence: number;
  superstep: number;
}

/** 创建初始可变状态:RUNNING、空集合、令牌与计数归零。 */
export function createMutableRunState(
  runId: string,
  policy: ControllerPolicy,
): MutableRunState {
  return {
    runId,
    status: RunStatus.RUNNING,
    policy,
    nodes: new Map(),
    specs: new Map(),
    runners: new Map(),
    inputs: new Map(),
    edges: [],
    executions: new Map(),
    decisions: [],
    processedResults: new Map(),
    archivedResults: new Map(),
    nodeReservations: new Map(),
    committedTokens: 0,
    reservedTokens: 0,
    enqueueSequence: 0,
    superstep: 0,
  };
}

/**
 * 将可变状态投影为冻结、确定性排序的 RunSnapshot。
 *
 * 排序:nodes 按 nodeId 升序、edges 按 edgeId 升序、executions 按 executionId
 * 升序(均为字典序);decisions 保持插入顺序(决策序本身即时间序,不重排)。
 * pendingExecutions = 处于 READY 或 RUNNING 的节点数。budget 由
 * committedTokens/reservedTokens 与 policy.maxTotalTokens 组装。
 */
export function snapshotOf(state: MutableRunState): RunSnapshot {
  const nodes = Object.freeze(
    [...state.nodes.values()].sort((a, b) =>
      a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0,
    ),
  );
  const edges = Object.freeze(
    [...state.edges].sort((a, b) =>
      a.edgeId < b.edgeId ? -1 : a.edgeId > b.edgeId ? 1 : 0,
    ),
  );
  const executions = Object.freeze(
    [...state.executions.values()].sort((a, b) =>
      a.executionId < b.executionId ? -1 : a.executionId > b.executionId ? 1 : 0,
    ),
  );
  const decisions = Object.freeze([...state.decisions]);

  let pendingExecutions = 0;
  for (const node of nodes) {
    if (node.state === NodeState.READY || node.state === NodeState.RUNNING) {
      pendingExecutions += 1;
    }
  }

  return Object.freeze({
    runId: state.runId,
    status: state.status,
    nodes,
    edges,
    executions,
    decisions,
    budget: createBudgetSnapshot({
      limitTokens: state.policy.maxTotalTokens,
      committedTokens: state.committedTokens,
      reservedTokens: state.reservedTokens,
    }),
    pendingExecutions,
    superstep: state.superstep,
  });
}
