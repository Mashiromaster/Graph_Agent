/**
 * 奖励信号:从一次运行的快照里提取按角色聚合的可观测量。
 *
 * ## 三类信号,按获取成本排序
 *
 *   1. **零成本(已记录)**:提案有效率。`snapshot.decisions` 本就记录每条提案
 *      被接受还是拒绝,按源节点归并到角色即可,不需任何额外 API 调用。
 *   2. **便宜**:节点失败率。从 `snapshot.nodes` 的终态统计。
 *   3. **任务级**:程序化评分。由 harness 在评分后提供。
 *
 * ## 为什么不做端到端 RL
 *
 * 调研 §15.3 明确告诫:「最终结果优秀并不表示每个参与 Agent 都有贡献。节点可能
 * 只重复前驱内容……早期应优先使用消融实验和可解释统计,不要过早依赖端到端
 * 强化学习。」本模块据此只产出可解释的统计量,信用分配交给**留一法角色消融**
 * (见 metrics.leaveOneOutContribution)。主动声明不做 RL 本身是严谨性信号。
 *
 * 确定性:纯函数;无 Date/random/IO。
 */

import { NodeState, type RunSnapshot } from "@graph-agent/orchestrator";
import type { TrustObservation } from "@graph-agent/orchestrator";

/** 单个角色在一次运行里的可观测量。 */
export interface RoleStats {
  readonly role: string;
  /** 该角色节点提出的提案总数。 */
  readonly proposals: number;
  /** 其中被控制器拒绝的条数。 */
  readonly rejected: number;
  /** 该角色的节点数。 */
  readonly nodes: number;
  /** 其中以 FAILED/BLOCKED 收场的节点数。 */
  readonly failures: number;
}

/** 按角色聚合一次运行的提案有效率与失败率。 */
export function collectRoleStats(snapshot: RunSnapshot): RoleStats[] {
  const roleOf = new Map<string, string>();
  for (const node of snapshot.nodes) {
    roleOf.set(node.nodeId, node.role);
  }

  const proposals = new Map<string, number>();
  const rejected = new Map<string, number>();
  for (const decision of snapshot.decisions) {
    const role = roleOf.get(decision.sourceNodeId);
    if (role === undefined) {
      continue;
    }
    proposals.set(role, (proposals.get(role) ?? 0) + 1);
    if (decision.state === "rejected") {
      rejected.set(role, (rejected.get(role) ?? 0) + 1);
    }
  }

  const nodes = new Map<string, number>();
  const failures = new Map<string, number>();
  for (const node of snapshot.nodes) {
    nodes.set(node.role, (nodes.get(node.role) ?? 0) + 1);
    if (node.state === NodeState.FAILED || node.state === NodeState.BLOCKED) {
      failures.set(node.role, (failures.get(node.role) ?? 0) + 1);
    }
  }

  const roles = [...new Set([...nodes.keys(), ...proposals.keys()])].sort();
  return roles.map((role) =>
    Object.freeze({
      role,
      proposals: proposals.get(role) ?? 0,
      rejected: rejected.get(role) ?? 0,
      nodes: nodes.get(role) ?? 0,
      failures: failures.get(role) ?? 0,
    }),
  );
}

/** 奖励权重;三项之和应为 1,否则 reward 会跑出 [0,1]。 */
export interface RewardWeights {
  readonly quality: number;
  readonly proposalValidity: number;
  readonly nodeSuccess: number;
}

export const DEFAULT_REWARD_WEIGHTS: RewardWeights = Object.freeze({
  quality: 0.6,
  proposalValidity: 0.2,
  nodeSuccess: 0.2,
});

/**
 * 把一次运行折算为按角色的 trust 观测。
 *
 * reward = w_q·quality + w_p·提案有效率 + w_s·节点成功率
 *
 * 三项都在 [0,1] 且权重和为 1,故 reward ∈ [0,1],可直接喂给 updateTrust。
 * 无提案/无节点的分量取 1(无罪推定),与 trust.DEFAULT_TRUST 的取向一致:
 * 缺数据不构成惩罚理由。
 *
 * quality 是**整次运行的任务分数**,对该运行内所有角色相同——这是刻意的粗粒度:
 * 精确的按角色归因需要留一法消融,而那是跨多次运行的分析,不是单次运行能给出的。
 * 把全局质量摊给参与角色,等价于「团队赢则人人有功」的弱先验,再由多次运行的
 * EMA 把真正稳定有贡献的角色筛出来。
 */
export function rewardObservations(
  snapshot: RunSnapshot,
  quality: number,
  weights: RewardWeights = DEFAULT_REWARD_WEIGHTS,
): TrustObservation[] {
  const total = weights.quality + weights.proposalValidity + weights.nodeSuccess;
  if (Math.abs(total - 1) > 1e-9) {
    throw new RangeError(`reward weights must sum to 1, got ${total}`);
  }
  if (!Number.isFinite(quality) || quality < 0 || quality > 1) {
    throw new RangeError(`quality must be in [0,1], got ${quality}`);
  }
  return collectRoleStats(snapshot).map((stats) => {
    const validity =
      stats.proposals === 0 ? 1 : (stats.proposals - stats.rejected) / stats.proposals;
    const success = stats.nodes === 0 ? 1 : (stats.nodes - stats.failures) / stats.nodes;
    const reward =
      weights.quality * quality +
      weights.proposalValidity * validity +
      weights.nodeSuccess * success;
    return Object.freeze({
      role: stats.role,
      reward: reward < 0 ? 0 : reward > 1 ? 1 : reward,
    });
  });
}
