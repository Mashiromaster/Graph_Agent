/**
 * 快照再校验(replay re-validation):对一份 RunSnapshot 做结构与不变量检查。
 *
 * 用于 replay/持久化恢复的信任边界——不信任外部重建的快照。函数「绝不抛错」:
 * 通过时返回 null,否则返回一个稳定的错误码字符串。任何意外抛错(字段缺失等)
 * 由外层 try/catch 归一为 "MALFORMED_SNAPSHOT"(fail-closed)。
 *
 * 错误码(均互斥、语义明确):
 *   RUN_ID_MISMATCH          runId 为空或与期望不符
 *   INVALID_NODE_ID          存在空/假值 node id
 *   DUPLICATE_NODE_ID        node id 重复
 *   INVALID_EDGE_ID          存在空/假值 edge id
 *   DUPLICATE_EDGE_ID        edge id 重复
 *   INVALID_EXECUTION_ID     存在空/假值 execution id
 *   DUPLICATE_EXECUTION_ID   execution id 重复
 *   DANGLING_EDGE            边的 source/target 不在节点集合内
 *   DANGLING_EXECUTION       execution.nodeId 不在节点集合内
 *   INVALID_BUDGET           预算整数不变量违背(见下)
 *   INVALID_EXECUTION_BUDGET 单条执行预算不变量违背
 *   PENDING_MISMATCH         pendingExecutions ≠ READY|RUNNING 节点数
 *   INVALID_SUPERSTEP        superstep 非非负整数
 *   INCONSISTENT_STATUS      运行状态与节点/pending 不一致
 *   MALFORMED_SNAPSHOT       校验过程中抛出任何异常(防御性兜底)
 */

import { NodeState, RunStatus } from "./graph-models.js";
import type { RunSnapshot } from "./graph-models.js";

function isNonNegativeInt(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

/** 校验快照结构与不变量;通过返回 null,否则返回错误码。绝不抛错。 */
export function validateSnapshot(
  snapshot: RunSnapshot,
  expectedRunId: string,
): string | null {
  try {
    if (!snapshot.runId || snapshot.runId !== expectedRunId) {
      return "RUN_ID_MISMATCH";
    }

    // 节点 id:非空且唯一。
    const nodeIds = new Set<string>();
    for (const node of snapshot.nodes) {
      if (!node.nodeId) {
        return "INVALID_NODE_ID";
      }
      if (nodeIds.has(node.nodeId)) {
        return "DUPLICATE_NODE_ID";
      }
      nodeIds.add(node.nodeId);
    }

    // 边 id:非空且唯一。
    const edgeIds = new Set<string>();
    for (const edge of snapshot.edges) {
      if (!edge.edgeId) {
        return "INVALID_EDGE_ID";
      }
      if (edgeIds.has(edge.edgeId)) {
        return "DUPLICATE_EDGE_ID";
      }
      edgeIds.add(edge.edgeId);
    }

    // 执行 id:非空且唯一。
    const executionIds = new Set<string>();
    for (const exec of snapshot.executions) {
      if (!exec.executionId) {
        return "INVALID_EXECUTION_ID";
      }
      if (executionIds.has(exec.executionId)) {
        return "DUPLICATE_EXECUTION_ID";
      }
      executionIds.add(exec.executionId);
    }

    // 边端点必须指向已知节点。
    for (const edge of snapshot.edges) {
      if (!nodeIds.has(edge.sourceNodeId) || !nodeIds.has(edge.targetNodeId)) {
        return "DANGLING_EDGE";
      }
    }

    // 执行必须归属已知节点。
    for (const exec of snapshot.executions) {
      if (!nodeIds.has(exec.nodeId)) {
        return "DANGLING_EXECUTION";
      }
    }

    // 聚合预算不变量:非负整数、limit≥1、committed+reserved≤limit。
    const budget = snapshot.budget;
    if (
      !isNonNegativeInt(budget.committedTokens) ||
      !isNonNegativeInt(budget.reservedTokens) ||
      !Number.isInteger(budget.limitTokens) ||
      budget.limitTokens < 1 ||
      budget.committedTokens + budget.reservedTokens > budget.limitTokens
    ) {
      return "INVALID_BUDGET";
    }

    // 单条执行预算:reserved≥1、committed≥0、committed≤reserved(均整数)。
    for (const exec of snapshot.executions) {
      if (
        !Number.isInteger(exec.reservedTokens) ||
        exec.reservedTokens < 1 ||
        !isNonNegativeInt(exec.committedTokens) ||
        exec.committedTokens > exec.reservedTokens
      ) {
        return "INVALID_EXECUTION_BUDGET";
      }
    }

    // pendingExecutions 必须等于 READY|RUNNING 节点数。
    let pending = 0;
    for (const node of snapshot.nodes) {
      if (node.state === NodeState.READY || node.state === NodeState.RUNNING) {
        pending += 1;
      }
    }
    if (snapshot.pendingExecutions !== pending) {
      return "PENDING_MISMATCH";
    }

    // superstep 必须为非负整数。
    if (!isNonNegativeInt(snapshot.superstep)) {
      return "INVALID_SUPERSTEP";
    }

    // 状态一致性。
    if (snapshot.status === RunStatus.SUCCEEDED) {
      for (const node of snapshot.nodes) {
        if (node.state !== NodeState.SUCCEEDED) {
          return "INCONSISTENT_STATUS";
        }
      }
    }
    if (snapshot.status !== RunStatus.RUNNING && snapshot.pendingExecutions !== 0) {
      return "INCONSISTENT_STATUS";
    }

    return null;
  } catch {
    return "MALFORMED_SNAPSHOT";
  }
}
