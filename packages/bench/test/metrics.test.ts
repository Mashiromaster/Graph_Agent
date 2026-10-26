import { describe, expect, it } from "vitest";
import {
  DEFAULT_OBJECTIVE,
  aggregateByCondition,
  digestConsistency,
  leaveOneOutContribution,
  objectiveValue,
  paretoFront,
  pairedCompare,
  stdDev,
  sweepObjective,
} from "../src/metrics.js";
import { extractAnswer, mathScorer, normalizeNumber } from "../src/scorers/math.js";
import { createTask, score } from "../src/task.js";
import { collectRoleStats, rewardObservations } from "../src/reward.js";
import type { RunRecord } from "../src/harness.js";
import {
  NodeState,
  RunStatus,
  createBudgetSnapshot,
  createNodeRecord,
  createProposalDecision,
  DecisionState,
  type RunSnapshot,
} from "@graph-agent/orchestrator";

// ── math scorer ─────────────────────────────────────────────────────────────

describe("normalizeNumber", () => {
  it("strips currency, thousands separators, and trailing zeros", () => {
    expect(normalizeNumber("1,234")).toBe("1234");
    expect(normalizeNumber("$1234")).toBe("1234");
    expect(normalizeNumber("1234.00")).toBe("1234");
    expect(normalizeNumber(" 1234 ")).toBe("1234");
    expect(normalizeNumber("-0")).toBe("0");
    expect(normalizeNumber("3.50")).toBe("3.5");
  });

  it("returns null for non-numbers", () => {
    expect(normalizeNumber("")).toBeNull();
    expect(normalizeNumber("abc")).toBeNull();
  });
});

describe("extractAnswer", () => {
  it("prefers an explicit marker over a trailing number", () => {
    expect(extractAnswer("Step 1: 99 apples. Answer: 42")).toBe("42");
    expect(extractAnswer("I think 7. Final answer: 13")).toBe("13");
    expect(extractAnswer("#### 42")).toBe("42");
    expect(extractAnswer("推导得到 7,答案：42")).toBe("42");
  });

  it("uses the last marker when several appear", () => {
    expect(extractAnswer("Answer: 1 ... revised. Answer: 2")).toBe("2");
  });

  it("falls back to the last number", () => {
    expect(extractAnswer("first 10 then 20 finally 30")).toBe("30");
  });

  it("returns null when no number is present", () => {
    expect(extractAnswer("no digits here")).toBeNull();
  });

  it("is robust to markdown emphasis around the answer", () => {
    expect(extractAnswer("Answer: **42**")).toBe("42");
  });
});

describe("mathScorer", () => {
  it("accepts formatting variants of the right answer", async () => {
    const scorer = mathScorer("1234");
    expect((await scorer("Answer: 1,234")).value).toBe(1);
    expect((await scorer("Answer: $1234.00")).value).toBe(1);
  });

  it("scores a wrong or missing answer as zero with a reason", async () => {
    const scorer = mathScorer("42");
    expect((await scorer("Answer: 41")).value).toBe(0);
    expect((await scorer("Answer: 41")).detail).toContain("expected 42");
    expect((await scorer(null)).detail).toBe("no output");
    expect((await scorer("no numbers")).detail).toContain("no number found");
  });

  it("rejects a non-numeric expected answer at construction", () => {
    expect(() => mathScorer("forty two")).toThrow();
  });

  it("is deterministic", async () => {
    const scorer = mathScorer("42");
    const a = await scorer("Answer: 42");
    const b = await scorer("Answer: 42");
    expect(a).toEqual(b);
  });
});

describe("createTask / score", () => {
  it("rejects an empty id or prompt", () => {
    const scorer = mathScorer("1");
    expect(() => createTask({ id: " ", family: "math", prompt: "p", scorer })).toThrow();
    expect(() => createTask({ id: "i", family: "math", prompt: " ", scorer })).toThrow();
  });

  it("rejects an out-of-range score", () => {
    expect(() => score(1.5, "bad")).toThrow();
    expect(() => score(-0.1, "bad")).toThrow();
  });
});

// ── records / metrics ───────────────────────────────────────────────────────

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    conditionKey: "A1+fanin+deliv",
    armId: "A1",
    fanIn: true,
    delivery: true,
    taskId: "t1",
    family: "math",
    seed: 0,
    model: "scripted",
    digest: "a".repeat(64),
    runStatus: "succeeded",
    quality: 1,
    qualityDetail: "matched",
    committedTokens: 1000,
    limitTokens: 20000,
    latencyMs: 1000,
    nodeCount: 1,
    edgeCount: 0,
    maxDepth: 0,
    failureCount: 0,
    proposalCount: 0,
    rejectedCount: 0,
    deliveredCount: 0,
    skipUtilization: null,
    modelCalls: 1,
    ...overrides,
  };
}

describe("objectiveValue", () => {
  it("subtracts normalized cost, latency, and failure penalties", () => {
    // quality 1 − 0.1*(1000/1000) − 0.01*(1000/1000) − 0.05*0 = 0.89
    expect(objectiveValue(record(), DEFAULT_OBJECTIVE)).toBeCloseTo(0.89, 10);
  });

  it("penalizes failures", () => {
    const clean = objectiveValue(record());
    const failed = objectiveValue(record({ failureCount: 2 }));
    expect(clean - failed).toBeCloseTo(0.1, 10);
  });
});

describe("stdDev", () => {
  it("is the sample standard deviation and 0 below two samples", () => {
    expect(stdDev([])).toBe(0);
    expect(stdDev([5])).toBe(0);
    expect(stdDev([1, 3])).toBeCloseTo(Math.SQRT2, 10);
  });
});

describe("aggregateByCondition", () => {
  it("groups, averages, and reports variance with a CI", () => {
    const rows = [
      record({ quality: 1, seed: 0 }),
      record({ quality: 0, seed: 1 }),
      record({ quality: 1, seed: 2 }),
      record({ quality: 0, seed: 3 }),
    ];
    const [agg] = aggregateByCondition(rows);
    expect(agg!.runs).toBe(4);
    expect(agg!.meanQuality).toBe(0.5);
    expect(agg!.qualityStdDev).toBeCloseTo(0.5773502692, 8);
    expect(agg!.qualityCi95).toBeGreaterThan(0);
  });

  it("sorts groups by key for determinism", () => {
    const rows = [
      record({ conditionKey: "B" }),
      record({ conditionKey: "A" }),
    ];
    expect(aggregateByCondition(rows).map((a) => a.key)).toEqual(["A", "B"]);
  });
});

describe("pairedCompare", () => {
  it("pairs on taskId+seed+model and reports the mean delta", () => {
    const rows = [
      record({ conditionKey: "base", taskId: "t1", seed: 0, quality: 0 }),
      record({ conditionKey: "treat", taskId: "t1", seed: 0, quality: 1 }),
      record({ conditionKey: "base", taskId: "t2", seed: 0, quality: 1 }),
      record({ conditionKey: "treat", taskId: "t2", seed: 0, quality: 1 }),
    ];
    const cmp = pairedCompare(rows, "base", "treat");
    expect(cmp.pairs).toBe(2);
    expect(cmp.meanDelta).toBe(0.5);
    expect(cmp.wins).toBe(1);
    expect(cmp.ties).toBe(1);
    expect(cmp.losses).toBe(0);
  });

  it("skips unpaired records instead of imputing", () => {
    const rows = [
      record({ conditionKey: "base", taskId: "t1", quality: 0 }),
      record({ conditionKey: "treat", taskId: "t1", quality: 1 }),
      record({ conditionKey: "base", taskId: "orphan", quality: 1 }),
    ];
    expect(pairedCompare(rows, "base", "treat").pairs).toBe(1);
  });

  it("marks a consistent difference as significant and a noisy one as not", () => {
    const consistent = [0, 1, 2, 3, 4].flatMap((seed) => [
      record({ conditionKey: "base", seed, quality: 0 }),
      record({ conditionKey: "treat", seed, quality: 1 }),
    ]);
    expect(pairedCompare(consistent, "base", "treat").significant).toBe(true);

    const noisy = [0, 1, 2, 3].flatMap((seed) => [
      record({ conditionKey: "base", seed, quality: seed % 2 }),
      record({ conditionKey: "treat", seed, quality: (seed + 1) % 2 }),
    ]);
    expect(pairedCompare(noisy, "base", "treat").significant).toBe(false);
  });
});

describe("paretoFront", () => {
  it("keeps only non-dominated conditions", () => {
    const rows = [
      // cheap and good → on the front
      record({ conditionKey: "cheap-good", quality: 0.9, committedTokens: 100 }),
      // expensive and worse → dominated
      record({ conditionKey: "costly-bad", quality: 0.5, committedTokens: 900 }),
      // expensive but best → on the front
      record({ conditionKey: "costly-best", quality: 1, committedTokens: 900 }),
    ];
    const front = paretoFront(aggregateByCondition(rows)).map((p) => p.key);
    expect(front).toContain("cheap-good");
    expect(front).toContain("costly-best");
    expect(front).not.toContain("costly-bad");
  });

  it("sorts the front by ascending cost", () => {
    const rows = [
      record({ conditionKey: "b", quality: 1, committedTokens: 900 }),
      record({ conditionKey: "a", quality: 0.5, committedTokens: 100 }),
    ];
    expect(paretoFront(aggregateByCondition(rows)).map((p) => p.key)).toEqual(["a", "b"]);
  });
});

describe("sweepObjective", () => {
  it("reveals when the winner depends on the cost weight", () => {
    const rows = [
      record({ conditionKey: "cheap", quality: 0.8, committedTokens: 100 }),
      record({ conditionKey: "costly", quality: 1, committedTokens: 5000 }),
    ];
    const sweep = sweepObjective(rows, [
      { lambda: 0, mu: 0, nu: 0 }, // 不计成本 → 高质量者胜
      { lambda: 0.5, mu: 0, nu: 0 }, // 重罚成本 → 便宜者胜
    ]);
    expect(sweep[0]!.bestKey).toBe("costly");
    expect(sweep[1]!.bestKey).toBe("cheap");
  });
});

describe("digestConsistency", () => {
  it("flags a group whose repeated runs disagree", () => {
    const rows = [
      record({ digest: "a".repeat(64) }),
      record({ digest: "b".repeat(64) }),
    ];
    const result = digestConsistency(rows);
    expect(result.groups).toBe(1);
    expect(result.consistent).toBe(0);
    expect(result.inconsistent).toHaveLength(1);
  });

  it("passes when every group agrees", () => {
    const rows = [record({ seed: 0 }), record({ seed: 1 })];
    const result = digestConsistency(rows);
    expect(result.groups).toBe(2);
    expect(result.inconsistent).toEqual([]);
  });
});

describe("leaveOneOutContribution", () => {
  it("computes a marginal difference per role", () => {
    const rows = [
      record({ taskId: "t1", quality: 1 }),
      record({ taskId: "t2", quality: 0 }),
    ];
    const rolesOf = (r: RunRecord) =>
      r.taskId === "t1" ? ["orchestrator", "reviewer"] : ["orchestrator"];
    const contributions = leaveOneOutContribution(rows, rolesOf);
    const reviewer = contributions.find((c) => c.role === "reviewer")!;
    expect(reviewer.withRole).toBe(1);
    expect(reviewer.withoutRole).toBe(0);
    expect(reviewer.marginal).toBe(1);
    expect(reviewer.withRuns).toBe(1);
    expect(reviewer.withoutRuns).toBe(1);
  });
});

// ── reward ──────────────────────────────────────────────────────────────────

function snapshotWith(
  nodes: { nodeId: string; role: string; state: string }[],
  decisions: { sourceNodeId: string; rejected: boolean }[],
): RunSnapshot {
  return Object.freeze({
    runId: "r",
    status: RunStatus.SUCCEEDED,
    nodes: nodes.map((n) =>
      createNodeRecord({
        nodeId: n.nodeId,
        name: n.nodeId,
        role: n.role,
        parentNodeId: null,
        generation: 0,
        priority: 0.5,
        state: n.state as never,
        allowedToolNames: [],
        allocationTokens: 10,
      }),
    ),
    edges: [],
    executions: [],
    decisions: decisions.map((d, i) =>
      createProposalDecision({
        proposalId: `p${i}`,
        proposalType: "spawn",
        sourceNodeId: d.sourceNodeId,
        state: d.rejected ? DecisionState.REJECTED : DecisionState.ACCEPTED,
        code: "OK",
        message: "",
        materializedId: null,
      }),
    ),
    budget: createBudgetSnapshot({
      limitTokens: 100,
      committedTokens: 10,
      reservedTokens: 0,
    }),
    pendingExecutions: 0,
    superstep: 1,
  }) as unknown as RunSnapshot;
}

describe("collectRoleStats", () => {
  it("aggregates proposals, rejections, nodes, and failures per role", () => {
    const snapshot = snapshotWith(
      [
        { nodeId: "root", role: "orchestrator", state: NodeState.SUCCEEDED },
        { nodeId: "w1", role: "worker", state: NodeState.SUCCEEDED },
        { nodeId: "w2", role: "worker", state: NodeState.FAILED },
      ],
      [
        { sourceNodeId: "root", rejected: false },
        { sourceNodeId: "root", rejected: true },
      ],
    );
    const stats = collectRoleStats(snapshot);
    const orch = stats.find((s) => s.role === "orchestrator")!;
    expect(orch.proposals).toBe(2);
    expect(orch.rejected).toBe(1);
    const worker = stats.find((s) => s.role === "worker")!;
    expect(worker.nodes).toBe(2);
    expect(worker.failures).toBe(1);
  });

  it("sorts roles for determinism", () => {
    const snapshot = snapshotWith(
      [
        { nodeId: "z", role: "zeta", state: NodeState.SUCCEEDED },
        { nodeId: "a", role: "alpha", state: NodeState.SUCCEEDED },
      ],
      [],
    );
    expect(collectRoleStats(snapshot).map((s) => s.role)).toEqual(["alpha", "zeta"]);
  });
});

describe("rewardObservations", () => {
  it("blends quality, proposal validity, and node success", () => {
    const snapshot = snapshotWith(
      [{ nodeId: "root", role: "orchestrator", state: NodeState.SUCCEEDED }],
      [
        { sourceNodeId: "root", rejected: false },
        { sourceNodeId: "root", rejected: true },
      ],
    );
    // quality 1, validity 0.5, success 1 → 0.6*1 + 0.2*0.5 + 0.2*1 = 0.9
    const [obs] = rewardObservations(snapshot, 1);
    expect(obs!.role).toBe("orchestrator");
    expect(obs!.reward).toBeCloseTo(0.9, 10);
  });

  it("treats absent proposals and nodes as full marks (no penalty for no data)", () => {
    const snapshot = snapshotWith(
      [{ nodeId: "root", role: "orchestrator", state: NodeState.SUCCEEDED }],
      [],
    );
    const [obs] = rewardObservations(snapshot, 1);
    expect(obs!.reward).toBeCloseTo(1, 10);
  });

  it("stays within [0,1] and rejects bad inputs", () => {
    const snapshot = snapshotWith(
      [{ nodeId: "root", role: "orchestrator", state: NodeState.FAILED }],
      [],
    );
    const [obs] = rewardObservations(snapshot, 0);
    expect(obs!.reward).toBeGreaterThanOrEqual(0);
    expect(obs!.reward).toBeLessThanOrEqual(1);
    expect(() => rewardObservations(snapshot, 1.5)).toThrow();
    expect(() =>
      rewardObservations(snapshot, 1, { quality: 0.5, proposalValidity: 0.2, nodeSuccess: 0.2 }),
    ).toThrow("must sum to 1");
  });
});
