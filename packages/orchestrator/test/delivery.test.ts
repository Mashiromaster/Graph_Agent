import { describe, expect, it } from "vitest";
import { createControllerPolicy } from "../src/policy.js";
import {
  assembleContext,
  estimateTokens,
  rankDeliveries,
  selectWithinBudget,
  toContextPackets,
  trustOf,
  type Delivery,
} from "../src/delivery.js";
import {
  buildRelevanceModel,
  cosineRelevance,
  relevance,
  termVector,
  tokenize,
} from "../src/relevance.js";

function delivery(overrides: Partial<Delivery> = {}): Delivery {
  return {
    sourceNodeId: "src",
    content: "the quick brown fox",
    priority: 0.5,
    trust: 1,
    kind: "message",
    edgeId: "e-1",
    gate: 1,
    mandatory: false,
    ...overrides,
  };
}

// ── relevance ───────────────────────────────────────────────────────────────

describe("tokenize", () => {
  it("lowercases and drops tokens shorter than two characters", () => {
    expect(tokenize("A Quick brown-Fox 12 x")).toEqual([
      "quick",
      "brown",
      "fox",
      "12",
    ]);
  });

  it("returns an empty list for punctuation-only text", () => {
    expect(tokenize("!!! ... ???")).toEqual([]);
  });
});

describe("cosineRelevance", () => {
  it("is 1 for identical text", () => {
    const model = buildRelevanceModel(["alpha beta gamma", "delta"]);
    const v = termVector("alpha beta gamma");
    expect(cosineRelevance(v, v, model)).toBeCloseTo(1, 10);
  });

  it("is 0 when no tokens overlap", () => {
    const model = buildRelevanceModel(["alpha beta", "gamma delta"]);
    expect(relevance("alpha beta", "gamma delta", model)).toBe(0);
  });

  it("is 0 against an empty vector", () => {
    const model = buildRelevanceModel(["alpha", ""]);
    expect(relevance("alpha", "", model)).toBe(0);
  });

  it("ranks partial overlap between 0 and 1", () => {
    const model = buildRelevanceModel([
      "superconductivity at twelve kelvin",
      "superconductivity results",
      "unrelated cooking recipe",
    ]);
    const score = relevance(
      "superconductivity results",
      "superconductivity at twelve kelvin",
      model,
    );
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it("is symmetric", () => {
    const model = buildRelevanceModel(["alpha beta", "beta gamma"]);
    expect(relevance("alpha beta", "beta gamma", model)).toBeCloseTo(
      relevance("beta gamma", "alpha beta", model),
      12,
    );
  });
});

// ── ranking ─────────────────────────────────────────────────────────────────

describe("rankDeliveries", () => {
  it("orders by descending score", () => {
    const task = "superconductivity kelvin";
    const relevant = delivery({
      edgeId: "e-rel",
      content: "superconductivity kelvin measured",
    });
    const irrelevant = delivery({ edgeId: "e-irr", content: "cooking recipe" });
    const ranked = rankDeliveries([irrelevant, relevant], task);
    expect(ranked[0]!.delivery.edgeId).toBe("e-rel");
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });

  it("breaks ties deterministically by edgeId", () => {
    // 同内容、同 priority/trust/gate → 同分数;断连必须按 edgeId 升序。
    const a = delivery({ edgeId: "e-b" });
    const b = delivery({ edgeId: "e-a" });
    const ranked = rankDeliveries([a, b], "quick brown fox");
    expect(ranked.map((r) => r.delivery.edgeId)).toEqual(["e-a", "e-b"]);
    // 输入顺序颠倒不改变结果。
    const reversed = rankDeliveries([b, a], "quick brown fox");
    expect(reversed.map((r) => r.delivery.edgeId)).toEqual(["e-a", "e-b"]);
  });

  it("scales the score by priority, trust, and gate", () => {
    const task = "quick brown fox";
    const full = rankDeliveries([delivery()], task)[0]!;
    const halfPriority = rankDeliveries([delivery({ priority: 0.25 })], task)[0]!;
    expect(halfPriority.score).toBeCloseTo(full.score * 0.5, 10);
    const gated = rankDeliveries([delivery({ gate: 0 })], task)[0]!;
    expect(gated.score).toBe(0);
    const untrusted = rankDeliveries([delivery({ trust: 0 })], task)[0]!;
    expect(untrusted.score).toBe(0);
  });

  it("returns an empty list for no deliveries", () => {
    expect(rankDeliveries([], "task")).toEqual([]);
  });
});

// ── budget / Top-K selection ────────────────────────────────────────────────

describe("estimateTokens", () => {
  it("is 4 chars per token with a floor of 1", () => {
    expect(estimateTokens("")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("selectWithinBudget", () => {
  const task = "quick brown fox";

  it("drops zero-score discretionary deliveries", () => {
    const scored = rankDeliveries([delivery({ content: "nothing in common" })], task);
    const selected = selectWithinBudget(scored, {
      topK: 10,
      tokenBudget: 1000,
      maxDeliveries: 10,
    });
    expect(selected).toHaveLength(0);
  });

  it("truncates to the token budget, skipping oversized entries", () => {
    const long = delivery({
      edgeId: "e-long",
      content: `quick brown fox ${"x".repeat(400)}`,
    });
    const short = delivery({ edgeId: "e-short", content: "quick brown fox" });
    const scored = rankDeliveries([long, short], task);
    const selected = selectWithinBudget(scored, {
      topK: 10,
      tokenBudget: 10,
      maxDeliveries: 10,
    });
    // 超预算的长条目被跳过,短条目仍入选(不是遇到超限即停)。
    expect(selected.map((s) => s.delivery.edgeId)).toEqual(["e-short"]);
  });

  it("caps the number of deliveries", () => {
    const items = [1, 2, 3, 4].map((i) =>
      delivery({ edgeId: `e-${i}`, content: "quick brown fox" }),
    );
    const selected = selectWithinBudget(rankDeliveries(items, task), {
      topK: 10,
      tokenBudget: 1000,
      maxDeliveries: 2,
    });
    expect(selected).toHaveLength(2);
  });

  it("applies Top-K to discretionary candidates only", () => {
    const items = [1, 2, 3].map((i) =>
      delivery({ edgeId: `e-${i}`, content: "quick brown fox" }),
    );
    const selected = selectWithinBudget(rankDeliveries(items, task), {
      topK: 1,
      tokenBudget: 1000,
      maxDeliveries: 10,
    });
    expect(selected).toHaveLength(1);
  });

  it("admits mandatory deliveries despite a zero relevance score", () => {
    // 这是 depends_on 的语义:声明式数据流不受相关性否决。
    const mandatory = delivery({
      edgeId: "e-dep",
      content: "totally unrelated payload",
      kind: "depends_on",
      mandatory: true,
    });
    const scored = rankDeliveries([mandatory], task);
    expect(scored[0]!.score).toBe(0);
    const selected = selectWithinBudget(scored, {
      topK: 10,
      tokenBudget: 1000,
      maxDeliveries: 10,
    });
    expect(selected.map((s) => s.delivery.edgeId)).toEqual(["e-dep"]);
  });

  it("still charges mandatory deliveries against the token budget", () => {
    const mandatory = delivery({
      edgeId: "e-dep",
      content: "x".repeat(400),
      mandatory: true,
    });
    const selected = selectWithinBudget(rankDeliveries([mandatory], task), {
      topK: 10,
      tokenBudget: 5,
      maxDeliveries: 10,
    });
    expect(selected).toHaveLength(0);
  });

  it("bypasses Top-K for mandatory deliveries", () => {
    const deps = [1, 2, 3].map((i) =>
      delivery({
        edgeId: `e-dep-${i}`,
        content: `dependency output ${i}`,
        mandatory: true,
      }),
    );
    const selected = selectWithinBudget(rankDeliveries(deps, task), {
      topK: 1,
      tokenBudget: 1000,
      maxDeliveries: 10,
    });
    expect(selected).toHaveLength(3);
  });
});

// ── packaging ───────────────────────────────────────────────────────────────

describe("toContextPackets", () => {
  it("carries source, trust, and kind onto the packet", () => {
    const scored = rankDeliveries(
      [delivery({ sourceNodeId: "w1", trust: 0.8, kind: "depends_on" })],
      "quick brown fox",
    );
    const packets = toContextPackets(scored);
    expect(packets).toHaveLength(1);
    expect(packets[0]!.sourceNodeId).toBe("w1");
    expect(packets[0]!.trust).toBe(0.8);
    expect(packets[0]!.edgeType).toBe("depends_on");
    expect(packets[0]!.content).toBe("the quick brown fox");
  });

  it("drops blank content instead of throwing", () => {
    // createContextPacket 对空串 fail-closed;过滤避免一条退化投递让整个
    // frontier-freeze 抛错。
    const scored = rankDeliveries([delivery({ content: "   " })], "task");
    expect(toContextPackets(scored)).toHaveLength(0);
  });
});

// ── end to end ──────────────────────────────────────────────────────────────

describe("assembleContext", () => {
  it("filters sources below minTrustScore before scoring", () => {
    const policy = createControllerPolicy({ minTrustScore: 0.5 });
    const trusted = delivery({ edgeId: "e-ok", trust: 0.9 });
    const untrusted = delivery({ edgeId: "e-no", trust: 0.1 });
    const packets = assembleContext([trusted, untrusted], "quick brown fox", policy);
    expect(packets).toHaveLength(1);
    expect(packets[0]!.trust).toBe(0.9);
  });

  it("drops a low-trust mandatory delivery too", () => {
    // minTrustScore 是安全门,优先于数据流声明:注入的恶意 agent 不能靠
    // 声明一条 depends_on 边就绕过可信度门槛。
    const policy = createControllerPolicy({ minTrustScore: 0.5 });
    const packets = assembleContext(
      [delivery({ trust: 0.1, mandatory: true })],
      "quick brown fox",
      policy,
    );
    expect(packets).toHaveLength(0);
  });

  it("honours the policy token budget", () => {
    const policy = createControllerPolicy({ contextInjectionTokenBudget: 1 });
    const packets = assembleContext(
      [delivery({ content: "quick brown fox and a long tail of extra words" })],
      "quick brown fox",
      policy,
    );
    expect(packets).toHaveLength(0);
  });

  it("returns an empty list when nothing is relevant", () => {
    const policy = createControllerPolicy();
    expect(assembleContext([delivery({ content: "zzz" })], "task", policy)).toEqual([]);
  });
});

// ── trustOf ─────────────────────────────────────────────────────────────────

describe("trustOf", () => {
  it("reads trustScore off the opaque spec", () => {
    const state = {
      specs: new Map<string, unknown>([["n", { identity: { trustScore: 0.25 } }]]),
    };
    expect(trustOf(state, "n")).toBe(0.25);
  });

  it("falls back to 1 when the spec or field is missing or invalid", () => {
    const state = {
      specs: new Map<string, unknown>([
        ["missing-field", { identity: {} }],
        ["bad-type", { identity: { trustScore: "high" } }],
        ["out-of-range", { identity: { trustScore: 1.5 } }],
        ["not-finite", { identity: { trustScore: Number.NaN } }],
      ]),
    };
    expect(trustOf(state, "absent")).toBe(1);
    expect(trustOf(state, "missing-field")).toBe(1);
    expect(trustOf(state, "bad-type")).toBe(1);
    expect(trustOf(state, "out-of-range")).toBe(1);
    expect(trustOf(state, "not-finite")).toBe(1);
  });
});
