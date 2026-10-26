/**
 * 指标与统计:R 目标函数、Pareto 前沿、跨种子方差、逐实例配对比较、留一法贡献。
 *
 * ## 为什么 R 之外还要 Pareto 前沿
 *
 * `R = Quality − λCost − μLatency − νFailure`(调研 §14)把多目标压成一个标量,
 * 而标量化的结论完全取决于 λ/μ/ν 的取值。若只报一组权重下的 R,审稿人有理由
 * 怀疑权重是事后挑的。两条应对:(1) 扫一组权重并报告结论在扫描下是否稳定;
 * (2) 以 Pareto 前沿为主图——它不需要任何权重假设。R 作为辅助摘要。
 *
 * ## 为什么必须逐实例配对
 *
 * 不同题目的难度差异远大于不同 arm 的效应。比较两个 arm 的**均值**会让题目难度
 * 的方差淹没拓扑效应。配对比较(同一 taskId、同一 seed 下作差)消掉题目效应,
 * 这是本实验能在 40 题规模上有统计功效的前提。
 *
 * 确定性:纯函数;无 Date/random。排序均有稳定断连键。
 */

import type { RunRecord } from "./harness.js";

/** R 的权重。 */
export interface Objective {
  /** λ:每 1000 token 的质量代价。 */
  readonly lambda: number;
  /** μ:每秒延迟的质量代价。 */
  readonly mu: number;
  /** ν:每次失败的质量代价。 */
  readonly nu: number;
}

export const DEFAULT_OBJECTIVE: Objective = Object.freeze({
  lambda: 0.1,
  mu: 0.01,
  nu: 0.05,
});

/**
 * R = Quality − λ·(tokens/1000) − μ·(latency/1000ms) − νFailure。
 *
 * 成本与延迟做了量纲归一(千 token、秒),否则 λ/μ 的数量级会与 Quality∈[0,1]
 * 相差几个数量级,扫描区间难以解释。
 */
export function objectiveValue(
  record: RunRecord,
  objective: Objective = DEFAULT_OBJECTIVE,
): number {
  return (
    record.quality -
    objective.lambda * (record.committedTokens / 1000) -
    objective.mu * (record.latencyMs / 1000) -
    objective.nu * record.failureCount
  );
}

// ── 汇总 ────────────────────────────────────────────────────────────────────

export interface Aggregate {
  readonly key: string;
  readonly runs: number;
  readonly meanQuality: number;
  readonly meanTokens: number;
  readonly meanLatencyMs: number
  readonly meanFailures: number;
  readonly meanObjective: number;
  /** 跨种子的质量标准差(样本标准差,n−1)。方差本身是要报告的指标。 */
  readonly qualityStdDev: number;
  /** 质量均值的 95% 置信区间半宽(正态近似)。 */
  readonly qualityCi95: number;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** 样本标准差(n−1);n<2 时为 0。 */
export function stdDev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  let acc = 0;
  for (const v of values) {
    acc += (v - m) * (v - m);
  }
  return Math.sqrt(acc / (values.length - 1));
}

/** 按 conditionKey 汇总。 */
export function aggregateByCondition(
  records: readonly RunRecord[],
  objective: Objective = DEFAULT_OBJECTIVE,
): Aggregate[] {
  const groups = new Map<string, RunRecord[]>();
  for (const record of records) {
    const bucket = groups.get(record.conditionKey);
    if (bucket === undefined) {
      groups.set(record.conditionKey, [record]);
    } else {
      bucket.push(record);
    }
  }
  const keys = [...groups.keys()].sort();
  return keys.map((key) => {
    const rows = groups.get(key)!;
    const qualities = rows.map((r) => r.quality);
    const sd = stdDev(qualities);
    return Object.freeze({
      key,
      runs: rows.length,
      meanQuality: mean(qualities),
      meanTokens: mean(rows.map((r) => r.committedTokens)),
      meanLatencyMs: mean(rows.map((r) => r.latencyMs)),
      meanFailures: mean(rows.map((r) => r.failureCount)),
      meanObjective: mean(rows.map((r) => objectiveValue(r, objective))),
      qualityStdDev: sd,
      qualityCi95: rows.length < 2 ? 0 : (1.96 * sd) / Math.sqrt(rows.length),
    });
  });
}

// ── 逐实例配对比较 ──────────────────────────────────────────────────────────

export interface PairedComparison {
  readonly baselineKey: string;
  readonly treatmentKey: string;
  /** 配对数(同 taskId 同 seed 两侧都有记录)。 */
  readonly pairs: number;
  /** 质量差的均值(treatment − baseline)。 */
  readonly meanDelta: number;
  readonly deltaStdDev: number;
  /** 均值差的 95% 置信区间半宽。 */
  readonly ci95: number;
  /** treatment 严格更好的配对数。 */
  readonly wins: number;
  readonly losses: number;
  readonly ties: number;
  /** 置信区间是否完全不含 0(即在 0.05 水平上显著)。 */
  readonly significant: boolean;
}

function pairKey(record: RunRecord): string {
  return `${record.taskId}::${record.seed}::${record.model}`;
}

/**
 * 两个条件的逐实例配对比较。
 *
 * 只统计两侧都存在的配对;单侧缺失(例如一次运行崩溃)被跳过并反映在 `pairs` 上,
 * 不做任何插补——插补会凭空制造信号。
 */
export function pairedCompare(
  records: readonly RunRecord[],
  baselineKey: string,
  treatmentKey: string,
): PairedComparison {
  const baseline = new Map<string, RunRecord>();
  const treatment = new Map<string, RunRecord>();
  for (const record of records) {
    if (record.conditionKey === baselineKey) {
      baseline.set(pairKey(record), record);
    } else if (record.conditionKey === treatmentKey) {
      treatment.set(pairKey(record), record);
    }
  }
  const deltas: number[] = [];
  let wins = 0;
  let losses = 0;
  let ties = 0;
  for (const key of [...baseline.keys()].sort()) {
    const b = baseline.get(key)!;
    const t = treatment.get(key);
    if (t === undefined) continue;
    const delta = t.quality - b.quality;
    deltas.push(delta);
    if (delta > 0) wins += 1;
    else if (delta < 0) losses += 1;
    else ties += 1;
  }
  const sd = stdDev(deltas);
  const ci95 = deltas.length < 2 ? 0 : (1.96 * sd) / Math.sqrt(deltas.length);
  const meanDelta = mean(deltas);
  return Object.freeze({
    baselineKey,
    treatmentKey,
    pairs: deltas.length,
    meanDelta,
    deltaStdDev: sd,
    ci95,
    wins,
    losses,
    ties,
    significant: deltas.length >= 2 && Math.abs(meanDelta) > ci95,
  });
}

// ── Pareto 前沿 ─────────────────────────────────────────────────────────────

export interface ParetoPoint {
  readonly key: string;
  readonly quality: number;
  readonly tokens: number;
}

/**
 * 质量—成本平面上的 Pareto 前沿(质量越高越好,token 越低越好)。
 *
 * 不需要任何权重假设,故它是主图:一个配置只有在「没有任何其他配置同时更便宜
 * 且不更差」时才在前沿上。
 */
export function paretoFront(aggregates: readonly Aggregate[]): ParetoPoint[] {
  const points: ParetoPoint[] = aggregates.map((a) => ({
    key: a.key,
    quality: a.meanQuality,
    tokens: a.meanTokens,
  }));
  const front = points.filter(
    (p) =>
      !points.some(
        (q) =>
          q.key !== p.key &&
          q.tokens <= p.tokens &&
          q.quality >= p.quality &&
          (q.tokens < p.tokens || q.quality > p.quality),
      ),
  );
  return front.sort((a, b) =>
    a.tokens !== b.tokens ? a.tokens - b.tokens : a.key < b.key ? -1 : 1,
  );
}

/**
 * 在一组 λ/μ/ν 下重算排名,报告「最优配置是否随权重改变」。
 *
 * 结论稳定(全扫描下同一个赢家)才敢说某配置更优;否则必须把结论限定在权重区间内。
 * 这是对 R 标量化最直接的稳健性检验。
 */
export function sweepObjective(
  records: readonly RunRecord[],
  objectives: readonly Objective[],
): { objective: Objective; bestKey: string; bestValue: number }[] {
  return objectives.map((objective) => {
    const aggregates = aggregateByCondition(records, objective);
    let bestKey = "";
    let bestValue = Number.NEGATIVE_INFINITY;
    for (const a of aggregates) {
      // 断连按 key 升序,保证确定性。
      if (a.meanObjective > bestValue || (a.meanObjective === bestValue && a.key < bestKey)) {
        bestValue = a.meanObjective;
        bestKey = a.key;
      }
    }
    return { objective, bestKey, bestValue };
  });
}

// ── 留一法角色贡献 ──────────────────────────────────────────────────────────

export interface RoleContribution {
  readonly role: string;
  /** 含该角色的运行的平均质量。 */
  readonly withRole: number;
  /** 不含该角色的运行的平均质量。 */
  readonly withoutRole: number;
  /** 边际贡献 = withRole − withoutRole。 */
  readonly marginal: number;
  readonly withRuns: number;
  readonly withoutRuns: number;
}

/**
 * 留一法角色边际贡献。
 *
 * 这是调研 §15.3 指定的替代方案:不做端到端 RL,而用可解释的消融统计。
 * 注意它是**相关性**而非因果——角色是否出现由模型决定,不是随机分配的,
 * 故存在选择偏差(例如模型只在难题上派生 reviewer,会让 reviewer 的边际贡献
 * 看起来是负的)。论文里必须如实标注这一点,不能当成因果效应。
 *
 * @param rolesOf 从 taskId::seed::model 到该次运行出现过的角色集合
 */
export function leaveOneOutContribution(
  records: readonly RunRecord[],
  rolesOf: (record: RunRecord) => readonly string[],
): RoleContribution[] {
  const allRoles = new Set<string>();
  for (const record of records) {
    for (const role of rolesOf(record)) {
      allRoles.add(role);
    }
  }
  return [...allRoles].sort().map((role) => {
    const withRole: number[] = [];
    const withoutRole: number[] = [];
    for (const record of records) {
      if (rolesOf(record).includes(role)) {
        withRole.push(record.quality);
      } else {
        withoutRole.push(record.quality);
      }
    }
    const w = mean(withRole);
    const wo = mean(withoutRole);
    return Object.freeze({
      role,
      withRole: w,
      withoutRole: wo,
      marginal: w - wo,
      withRuns: withRole.length,
      withoutRuns: withoutRole.length,
    });
  });
}

/** 摘要:确定性验证所需的摘要一致性检查。 */
export function digestConsistency(records: readonly RunRecord[]): {
  groups: number;
  consistent: number;
  inconsistent: string[];
} {
  // 同一 (condition, task, seed, model) 的多次运行必须得到同一摘要。
  const groups = new Map<string, Set<string>>();
  for (const record of records) {
    const key = `${record.conditionKey}::${record.taskId}::${record.seed}::${record.model}`;
    const bucket = groups.get(key);
    if (bucket === undefined) {
      groups.set(key, new Set([record.digest]));
    } else {
      bucket.add(record.digest);
    }
  }
  const inconsistent: string[] = [];
  for (const [key, digests] of groups) {
    if (digests.size > 1) {
      inconsistent.push(key);
    }
  }
  return {
    groups: groups.size,
    consistent: groups.size - inconsistent.length,
    inconsistent: inconsistent.sort(),
  };
}
