/**
 * 端到端管线:多臂 × 多题 × 多种子 → JSONL → 汇总 / 配对比较 / Pareto / 确定性核验。
 *
 * 全部由 ScriptedModel 驱动,故这是一次**完整但离线**的实验演练:它验证管线
 * 能产出论文 §6 所需的全部统计量,而无需任何 API 调用。真实实验只是把
 * modelFactory 换成 OpenAICompatibleModel,其余不变。
 *
 * 这里也顺带验证了 digestConsistency:同一 (条件,题,种子) 重复跑必须得到同一
 * 摘要——即把 harness 本身纳入「运行时贡献零熵」的覆盖范围。
 */

import { describe, expect, it } from "vitest";
import {
  ScriptedModel,
  createModelResponse,
  createToolCall,
  type ModelAdapter,
} from "@graph-agent/adapter";
import { createUsage } from "@graph-agent/core";
import { SPAWN_TOOL } from "@graph-agent/node";
import { ARMS, DEFAULT_TOGGLES, conditionKey, type Condition } from "../src/arms.js";
import { createTask, type TaskInstance } from "../src/task.js";
import { mathScorer } from "../src/scorers/math.js";
import { runOne, toJsonLine, type ModelFactory, type RunRecord } from "../src/harness.js";
import {
  aggregateByCondition,
  digestConsistency,
  paretoFront,
  pairedCompare,
  sweepObjective,
} from "../src/metrics.js";

const TASKS: TaskInstance[] = [
  createTask({
    id: "sum-1",
    family: "math",
    prompt: "What is 17 plus 25?",
    scorer: mathScorer("42"),
  }),
  createTask({
    id: "sum-2",
    family: "math",
    prompt: "What is 100 minus 58?",
    scorer: mathScorer("42"),
  }),
];

/** 正确答案的期望表:按题与种子决定脚本是否答对,模拟质量差异。 */
function answerFor(taskId: string, armId: string, seed: number): string {
  // A1(单 agent)在种子为奇数时答错,多 agent 臂恒对 → 人为制造一个可检出的效应。
  if (armId === "A1" && seed % 2 === 1) {
    return "41";
  }
  void taskId;
  return "42";
}

function soloModel(answer: string): ModelAdapter {
  return new ScriptedModel([
    createModelResponse({
      content: `Working it out. Answer: ${answer}`,
      usage: createUsage({ inputTokens: 20, outputTokens: 10 }),
    }),
  ]);
}

function spawningModel(answer: string): ModelFactory {
  return ({ nodeId }) => {
    if (nodeId === "root") {
      return new ScriptedModel([
        createModelResponse({
          content: null,
          toolCalls: [
            createToolCall({
              id: "tc-1",
              name: SPAWN_TOOL,
              arguments: {
                proposal_id: "sp-a",
                generation: 1,
                role: "worker",
                objective: "compute the value",
                instructions: "do the arithmetic",
                tool_names: [],
                priority: 0.5,
                budget_share: 0.2,
              },
            }),
            createToolCall({
              id: "tc-2",
              name: SPAWN_TOOL,
              arguments: {
                proposal_id: "sp-b",
                generation: 1,
                role: "reducer",
                objective: "report the value",
                instructions: "state the result",
                tool_names: [],
                priority: 0.5,
                budget_share: 0.2,
              },
            }),
          ],
          usage: createUsage({ inputTokens: 40, outputTokens: 20 }),
        }),
        createModelResponse({
          content: `Children converged. Answer: ${answer}`,
          usage: createUsage({ inputTokens: 30, outputTokens: 12 }),
        }),
      ]);
    }
    return new ScriptedModel([
      createModelResponse({
        content: `Computed ${answer}`,
        usage: createUsage({ inputTokens: 14, outputTokens: 7 }),
      }),
    ]);
  };
}

function fakeClock(): () => number {
  let t = 0;
  return () => {
    t += 10;
    return t;
  };
}

/** 跑 A1 与 A3 两臂 × 2 题 × 4 种子。 */
async function runGrid(): Promise<RunRecord[]> {
  const conditions: Condition[] = [
    { arm: ARMS.find((a) => a.id === "A1")!, toggles: DEFAULT_TOGGLES },
    { arm: ARMS.find((a) => a.id === "A3")!, toggles: DEFAULT_TOGGLES },
  ];
  const records: RunRecord[] = [];
  for (const condition of conditions) {
    for (const task of TASKS) {
      for (const seed of [0, 1, 2, 3]) {
        const answer = answerFor(task.id, condition.arm.id, seed);
        const factory: ModelFactory = condition.arm.spawn
          ? spawningModel(answer)
          : () => soloModel(answer);
        const { record } = await runOne({
          condition,
          task,
          seed,
          modelName: "scripted",
          modelFactory: factory,
          wallClock: fakeClock(),
        });
        records.push(record);
      }
    }
  }
  return records;
}

describe("end-to-end experiment pipeline", () => {
  it("produces one record per cell of the grid", async () => {
    const records = await runGrid();
    expect(records).toHaveLength(2 * 2 * 4);
    for (const record of records) {
      expect(record.runStatus).toBe("succeeded");
      expect(record.committedTokens).toBeLessThanOrEqual(record.limitTokens);
      expect(JSON.parse(toJsonLine(record))).toMatchObject({ taskId: record.taskId });
    }
  });

  it("aggregates with variance and a confidence interval per condition", async () => {
    const records = await runGrid();
    const aggregates = aggregateByCondition(records);
    expect(aggregates).toHaveLength(2);
    const a1 = aggregates.find((a) => a.key.startsWith("A1"))!;
    const a3 = aggregates.find((a) => a.key.startsWith("A3"))!;
    // A1 在奇数种子上答错 → 均值 0.5,且方差非零。
    expect(a1.meanQuality).toBe(0.5);
    expect(a1.qualityStdDev).toBeGreaterThan(0);
    expect(a1.qualityCi95).toBeGreaterThan(0);
    // A3 恒对 → 均值 1,方差 0。
    expect(a3.meanQuality).toBe(1);
    expect(a3.qualityStdDev).toBe(0);
    // 多 agent 臂更贵。
    expect(a3.meanTokens).toBeGreaterThan(a1.meanTokens);
  });

  it("detects the injected effect by paired comparison", async () => {
    const records = await runGrid();
    const a1Key = conditionKey({
      arm: ARMS.find((a) => a.id === "A1")!,
      toggles: DEFAULT_TOGGLES,
    });
    const a3Key = conditionKey({
      arm: ARMS.find((a) => a.id === "A3")!,
      toggles: DEFAULT_TOGGLES,
    });
    const cmp = pairedCompare(records, a1Key, a3Key);
    expect(cmp.pairs).toBe(8);
    expect(cmp.meanDelta).toBe(0.5);
    expect(cmp.wins).toBe(4);
    expect(cmp.losses).toBe(0);
    expect(cmp.significant).toBe(true);
  });

  it("builds a Pareto front over quality and cost", async () => {
    const records = await runGrid();
    const front = paretoFront(aggregateByCondition(records));
    // A1 更便宜、A3 质量更高 → 两者都非被支配。
    expect(front).toHaveLength(2);
    expect(front[0]!.tokens).toBeLessThan(front[1]!.tokens);
  });

  it("shows the winner flipping under a cost-weight sweep", async () => {
    const records = await runGrid();
    // 本演练的 token 量级是脚本化的玩具值(A1≈30,A3≈144),故翻转阈值在
    // λ≈4.39:解 0.5−0.03λ > 1−0.144λ 得 λ > 0.5/0.114。真实实验的 token 是
    // 千量级,λ=0.1 这类默认值即足以体现成本压力——这里取 10 只是为了在玩具
    // 量级上跨过同一个阈值,被检验的是 sweep **能暴露排名翻转**这一机制。
    const sweep = sweepObjective(records, [
      { lambda: 0, mu: 0, nu: 0 },
      { lambda: 10, mu: 0, nu: 0 },
    ]);
    // 不计成本时质量取胜;重罚成本时便宜的单 agent 取胜。
    expect(sweep[0]!.bestKey.startsWith("A3")).toBe(true);
    expect(sweep[1]!.bestKey.startsWith("A1")).toBe(true);
    // 结论随权重改变 → 论文必须以 Pareto 前沿为主图,R 仅作辅助摘要。
    expect(sweep[0]!.bestKey).not.toBe(sweep[1]!.bestKey);
  });

  it("yields identical digests when the grid is re-run (zero harness entropy)", async () => {
    const first = await runGrid();
    const second = await runGrid();
    const combined = [...first, ...second];
    const consistency = digestConsistency(combined);
    expect(consistency.inconsistent).toEqual([]);
    expect(consistency.consistent).toBe(consistency.groups);
    // 更强的断言:逐行 JSONL 完全一致。
    expect(first.map(toJsonLine)).toEqual(second.map(toJsonLine));
  });
});
