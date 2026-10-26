import { createAgentIdentity, createNodeBudget } from "@graph-agent/core";
import { deriveId } from "@graph-agent/session";
import { describe, expect, it } from "vitest";
import { createAgentSpec } from "../src/spec.js";
import {
  GRAPH_TOOL_DEFINITIONS,
  MESSAGE_TOOL,
  ProposalCollector,
  SKIP_CONTEXT_TOOL,
  SPAWN_TOOL,
  graphToolDefinitionsFor,
} from "../src/graph-tools.js";

function makeSpec(policy?: Parameters<typeof createAgentSpec>[0]["policy"]) {
  return createAgentSpec({
    identity: createAgentIdentity({
      nodeId: "node-1",
      name: "root",
      role: "planner",
      generation: 0,
    }),
    budget: createNodeBudget(),
    instructions: "do the work",
    ...(policy !== undefined ? { policy } : {}),
  });
}

const HEX64 = /^[0-9a-f]{64}$/;

describe("GRAPH_TOOL_DEFINITIONS", () => {
  it("exposes three tool definitions with the expected names", () => {
    const names = GRAPH_TOOL_DEFINITIONS.map((d) => d.name);
    expect(names).toEqual([SPAWN_TOOL, MESSAGE_TOOL, SKIP_CONTEXT_TOOL]);
  });
});

describe("ProposalCollector spawn", () => {
  it("accepts a valid spawn proposal", () => {
    const spec = makeSpec();
    const collector = new ProposalCollector({
      spec,
      availableToolNames: new Set(["search", "read"]),
    });
    const res = collector.invoke(
      SPAWN_TOOL,
      {
        role: "researcher",
        objective: "find facts",
        instructions: "search the web",
        tool_names: ["search"],
        priority: 0.7,
        budget_share: 0.3,
      },
      0,
    );
    expect(res.accepted).toBe(true);
    expect(collector.spawns).toHaveLength(1);
    expect(res.proposal?.proposalId).toMatch(HEX64);
    expect(res.output).toContain("proposed");
  });

  it("rejects when generation would exceed maxGeneration", () => {
    const spec = createAgentSpec({
      identity: createAgentIdentity({
        nodeId: "deep",
        name: "n",
        role: "r",
        generation: 2,
      }),
      budget: createNodeBudget(),
      instructions: "x",
      policy: { maxGeneration: 2 },
    });
    const collector = new ProposalCollector({ spec, availableToolNames: new Set() });
    const res = collector.invoke(
      SPAWN_TOOL,
      { role: "r", objective: "o", instructions: "i" },
      0,
    );
    expect(res.accepted).toBe(false);
    expect(collector.spawns).toHaveLength(0);
  });

  it("rejects when maxChildren is exceeded", () => {
    const spec = makeSpec({ maxChildren: 1 });
    const collector = new ProposalCollector({ spec, availableToolNames: new Set() });
    const ok = collector.invoke(
      SPAWN_TOOL,
      { role: "r", objective: "o", instructions: "i", budget_share: 0.1 },
      0,
    );
    expect(ok.accepted).toBe(true);
    const rej = collector.invoke(
      SPAWN_TOOL,
      { role: "r", objective: "o", instructions: "i", budget_share: 0.1 },
      1,
    );
    expect(rej.accepted).toBe(false);
  });

  it("rejects tool names not in availableToolNames", () => {
    const spec = makeSpec();
    const collector = new ProposalCollector({
      spec,
      availableToolNames: new Set(["search"]),
    });
    const res = collector.invoke(
      SPAWN_TOOL,
      { role: "r", objective: "o", instructions: "i", tool_names: ["nope"] },
      0,
    );
    expect(res.accepted).toBe(false);
  });

  it("rejects cumulative budget_share exceeding 1", () => {
    const spec = makeSpec();
    const collector = new ProposalCollector({ spec, availableToolNames: new Set() });
    const a = collector.invoke(
      SPAWN_TOOL,
      { role: "r", objective: "o", instructions: "i", budget_share: 0.6 },
      0,
    );
    expect(a.accepted).toBe(true);
    const b = collector.invoke(
      SPAWN_TOOL,
      { role: "r", objective: "o", instructions: "i", budget_share: 0.6 },
      1,
    );
    expect(b.accepted).toBe(false);
    expect(collector.spawns).toHaveLength(1);
  });
});

describe("ProposalCollector message", () => {
  it("accepts a valid message when allowed", () => {
    const spec = makeSpec({ allowDirectMessages: true });
    const collector = new ProposalCollector({ spec, availableToolNames: new Set() });
    const res = collector.invoke(
      MESSAGE_TOOL,
      { target_node_id: "other", content: "hi", ttl_seconds: 60 },
      0,
    );
    expect(res.accepted).toBe(true);
    expect(collector.messages).toHaveLength(1);
  });

  it("rejects messages when allowDirectMessages is false", () => {
    const spec = makeSpec({ allowDirectMessages: false });
    const collector = new ProposalCollector({ spec, availableToolNames: new Set() });
    const res = collector.invoke(
      MESSAGE_TOOL,
      { target_node_id: "other", content: "hi" },
      0,
    );
    expect(res.accepted).toBe(false);
  });

  it("rejects a self-targeted message", () => {
    const spec = makeSpec({ allowDirectMessages: true });
    const collector = new ProposalCollector({ spec, availableToolNames: new Set() });
    const res = collector.invoke(
      MESSAGE_TOOL,
      { target_node_id: "node-1", content: "hi" },
      0,
    );
    expect(res.accepted).toBe(false);
  });
});

describe("ProposalCollector skip-context", () => {
  it("accepts a valid skip-context when allowed", () => {
    const spec = makeSpec({ allowSkipContext: true });
    const collector = new ProposalCollector({ spec, availableToolNames: new Set() });
    const res = collector.invoke(
      SKIP_CONTEXT_TOOL,
      { source_node_id: "src", reason: "irrelevant", context_gate: 0.2 },
      0,
    );
    expect(res.accepted).toBe(true);
    expect(collector.skipContexts).toHaveLength(1);
  });

  it("rejects skip-context when allowSkipContext is false", () => {
    const spec = makeSpec({ allowSkipContext: false });
    const collector = new ProposalCollector({ spec, availableToolNames: new Set() });
    const res = collector.invoke(
      SKIP_CONTEXT_TOOL,
      { source_node_id: "src", reason: "irrelevant" },
      0,
    );
    expect(res.accepted).toBe(false);
  });

  it("rejects a self-sourced skip-context", () => {
    const spec = makeSpec({ allowSkipContext: true });
    const collector = new ProposalCollector({ spec, availableToolNames: new Set() });
    const res = collector.invoke(
      SKIP_CONTEXT_TOOL,
      { source_node_id: "node-1", reason: "irrelevant" },
      0,
    );
    expect(res.accepted).toBe(false);
  });
});

describe("ProposalCollector dispatch", () => {
  it("rejects an unknown graph operation", () => {
    const spec = makeSpec();
    const collector = new ProposalCollector({ spec, availableToolNames: new Set() });
    const res = collector.invoke("graph__nope", {}, 0);
    expect(res.accepted).toBe(false);
    expect(res.output).toContain("unknown graph operation");
  });

  it("derives deterministic proposalIds that differ by ordinal and kind", () => {
    const spec = makeSpec({ allowDirectMessages: true });
    const c1 = new ProposalCollector({ spec, availableToolNames: new Set() });
    const s0 = c1.invoke(
      SPAWN_TOOL,
      { role: "r", objective: "o", instructions: "i" },
      0,
    );
    const c2 = new ProposalCollector({ spec, availableToolNames: new Set() });
    const s0again = c2.invoke(
      SPAWN_TOOL,
      { role: "r", objective: "o", instructions: "i" },
      0,
    );
    expect(s0.proposal?.proposalId).toBe(s0again.proposal?.proposalId);
    expect(s0.proposal?.proposalId).toBe(deriveId("node-1", "spawn", 0));

    const c3 = new ProposalCollector({ spec, availableToolNames: new Set() });
    const s1 = c3.invoke(
      SPAWN_TOOL,
      { role: "r", objective: "o", instructions: "i" },
      1,
    );
    expect(s1.proposal?.proposalId).not.toBe(s0.proposal?.proposalId);

    const c4 = new ProposalCollector({ spec, availableToolNames: new Set() });
    const m0 = c4.invoke(
      MESSAGE_TOOL,
      { target_node_id: "other", content: "hi" },
      0,
    );
    expect(m0.proposal?.proposalId).not.toBe(s0.proposal?.proposalId);
    expect(m0.proposal?.proposalId).toMatch(HEX64);
  });
});

describe("graphToolDefinitionsFor", () => {
  it("advertises only spawn by default (messages and skip are opt-in)", () => {
    const names = graphToolDefinitionsFor(makeSpec()).map((d) => d.name);
    expect(names).toEqual([SPAWN_TOOL]);
  });

  it("adds message and skip tools when the policy enables them", () => {
    const names = graphToolDefinitionsFor(
      makeSpec({ allowDirectMessages: true, allowSkipContext: true }),
    ).map((d) => d.name);
    expect(names).toEqual([SPAWN_TOOL, MESSAGE_TOOL, SKIP_CONTEXT_TOOL]);
  });

  it("withholds spawn when the node cannot have children", () => {
    // 模型若看到一个注定被拒的工具,会据此规划并产出无效提案,而那些拒绝
    // 还会计入提案有效率(reward 信号),把策略后果错记成模型失误。
    expect(graphToolDefinitionsFor(makeSpec({ maxChildren: 0 })).map((d) => d.name)).toEqual(
      [],
    );
    expect(
      graphToolDefinitionsFor(makeSpec({ maxGeneration: 0 })).map((d) => d.name),
    ).toEqual([]);
  });

  it("falls back to defaults when the spec carries no policy", () => {
    // 编排层物化子节点时构造的 spec 是 {identity, budget, role},不带 policy
    // (orchestrator 刻意不依赖 node)。缺失时必须退回默认值而非崩溃。
    const bare = {
      identity: createAgentIdentity({
        nodeId: "child",
        name: "child",
        role: "worker",
        generation: 1,
      }),
      budget: createNodeBudget({ maxTotalTokens: 100 }),
      role: "worker",
    } as unknown as Parameters<typeof graphToolDefinitionsFor>[0];
    expect(() => graphToolDefinitionsFor(bare)).not.toThrow();
    expect(graphToolDefinitionsFor(bare).map((d) => d.name)).toEqual([SPAWN_TOOL]);
  });

  it("never advertises a tool absent from GRAPH_TOOL_DEFINITIONS", () => {
    const all = new Set(GRAPH_TOOL_DEFINITIONS.map((d) => d.name));
    for (const def of graphToolDefinitionsFor(
      makeSpec({ allowDirectMessages: true, allowSkipContext: true }),
    )) {
      expect(all.has(def.name)).toBe(true);
    }
  });
});
