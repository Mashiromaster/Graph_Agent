import { describe, expect, it } from "vitest";
import { createModelResponse, ScriptedModel } from "@graph-agent/adapter";
import { AgentNode, type AgentSpec } from "@graph-agent/node";
import type { NodeFactory } from "@graph-agent/orchestrator";
import { parseResumableCheckpoint } from "@graph-agent/orchestrator";
import { InMemoryStorage } from "@graph-agent/session";
import {
  DeepSeekConfig,
  parseConversation,
  runResume,
  runStudioGraph,
  type StudioNodeResult,
} from "../src/studio.js";

const VALID_KEY = "sk-abcdefgh1234";

function validProvider(): Record<string, unknown> {
  return { type: "deepseek", api_key: VALID_KEY, model: "deepseek-v4-flash" };
}

describe("DeepSeekConfig.fromPayload", () => {
  it("accepts a valid payload", () => {
    const cfg = DeepSeekConfig.fromPayload(validProvider());
    expect(cfg.type).toBe("deepseek");
    expect(cfg.apiKey).toBe(VALID_KEY);
    expect(cfg.model).toBe("deepseek-v4-flash");
  });

  it("rejects non-object", () => {
    expect(() => DeepSeekConfig.fromPayload("nope")).toThrow();
    expect(() => DeepSeekConfig.fromPayload(null)).toThrow();
    expect(() => DeepSeekConfig.fromPayload([])).toThrow();
  });

  it("rejects extra or missing keys", () => {
    expect(() => DeepSeekConfig.fromPayload({ ...validProvider(), extra: 1 })).toThrow();
    expect(() => DeepSeekConfig.fromPayload({ type: "deepseek", api_key: VALID_KEY })).toThrow();
  });

  it("rejects wrong type", () => {
    expect(() => DeepSeekConfig.fromPayload({ ...validProvider(), type: "openai" })).toThrow();
  });

  it("rejects api_key that is too short or too long", () => {
    expect(() => DeepSeekConfig.fromPayload({ ...validProvider(), api_key: "short" })).toThrow();
    expect(() =>
      DeepSeekConfig.fromPayload({ ...validProvider(), api_key: "x".repeat(1025) }),
    ).toThrow();
  });

  it("rejects api_key with whitespace or control chars", () => {
    expect(() => DeepSeekConfig.fromPayload({ ...validProvider(), api_key: " abcdefgh " })).toThrow();
    expect(() =>
      DeepSeekConfig.fromPayload({ ...validProvider(), api_key: "abcdefgh" }),
    ).toThrow();
    expect(() => DeepSeekConfig.fromPayload({ ...validProvider(), api_key: 12345678 })).toThrow();
  });

  it("rejects unknown model", () => {
    expect(() => DeepSeekConfig.fromPayload({ ...validProvider(), model: "gpt-4" })).toThrow();
  });
});

describe("parseConversation", () => {
  it("accepts an empty array", () => {
    expect(parseConversation([])).toEqual([]);
  });

  it("accepts a valid alternating conversation", () => {
    const turns = parseConversation([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    expect(turns).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
  });

  it("rejects non-array", () => {
    expect(() => parseConversation({})).toThrow();
  });

  it("rejects more than 40 turns", () => {
    const many = Array.from({ length: 42 }, (_v, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: "x",
    }));
    expect(() => parseConversation(many)).toThrow();
  });

  it("rejects non-alternating order", () => {
    expect(() =>
      parseConversation([
        { role: "assistant", content: "hi" },
        { role: "user", content: "hello" },
      ]),
    ).toThrow();
  });

  it("rejects odd length (does not end with assistant)", () => {
    expect(() => parseConversation([{ role: "user", content: "hi" }])).toThrow();
  });

  it("rejects wrong keys", () => {
    expect(() =>
      parseConversation([{ role: "user", content: "hi", extra: 1 }]),
    ).toThrow();
  });

  it("rejects blank content", () => {
    expect(() =>
      parseConversation([
        { role: "user", content: "   " },
        { role: "assistant", content: "ok" },
      ]),
    ).toThrow();
  });

  it("rejects content over 8000 chars", () => {
    expect(() =>
      parseConversation([
        { role: "user", content: "x".repeat(8001) },
        { role: "assistant", content: "ok" },
      ]),
    ).toThrow();
  });

  it("rejects total content over 32000 chars", () => {
    const big = "x".repeat(8000);
    const items = [
      { role: "user", content: big },
      { role: "assistant", content: big },
      { role: "user", content: big },
      { role: "assistant", content: big },
      { role: "user", content: "y" },
      { role: "assistant", content: "z" },
    ];
    expect(() => parseConversation(items)).toThrow();
  });
});

/**
 * Injected factory: the root AgentNode is driven by a ScriptedModel that returns
 * a single COMPLETED turn (content, no tool calls). This produces a real event
 * chain accepted by the orchestrator — no network.
 */
function scriptedFactory(): NodeFactory {
  return {
    create({ spec, toolNames }) {
      if (toolNames.length > 0) {
        throw new Error("no tools");
      }
      const model = new ScriptedModel([
        createModelResponse({ content: "The answer is 42.", finishReason: "stop" }),
      ]);
      return new AgentNode({ spec: spec as AgentSpec, model });
    },
  };
}

describe("runStudioGraph", () => {
  it("drives the controller and returns a StudioResult", async () => {
    const provider = DeepSeekConfig.fromPayload(validProvider());
    let tick = 0;
    const clock = () => (tick += 1);
    const result = await runStudioGraph(
      { task: "What is the answer?", provider, conversation: [] },
      { factory: scriptedFactory(), clock },
    );

    expect(result.controller_event_chain_valid).toBe(true);
    expect(result.live).toBe(true);
    expect(result.task).toBe("What is the answer?");
    expect(result.primary_output).toBe("The answer is 42.");
    expect(result.provider).toEqual({
      endpoint: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      thinking: "harness-managed",
      type: "deepseek",
    });
    // snapshot present with root node.
    const nodes = result.snapshot["nodes"] as { nodeId: string; state: string }[];
    expect(nodes.some((n) => n.nodeId === "root")).toBe(true);
    // node_results populated for root.
    const root = result.node_results.find((r: StudioNodeResult) => r.node_id === "root");
    expect(root).toBeDefined();
    expect(root?.status).toBe("completed");
    expect(root?.output).toBe("The answer is 42.");
    // events summary shape.
    expect(result.event_count).toBe(result.events.length);
    expect(result.events.length).toBeGreaterThan(0);
    for (const e of result.events) {
      expect(e.hash).toHaveLength(12);
      expect(typeof e.sequence).toBe("number");
      expect(typeof e.type).toBe("string");
    }
    expect(result.elapsed_ms).toBeGreaterThanOrEqual(0);
  });

  it("passes conversation history as context", async () => {
    const provider = DeepSeekConfig.fromPayload(validProvider());
    const result = await runStudioGraph(
      {
        task: "Continue",
        provider,
        conversation: [
          { role: "user", content: "earlier question" },
          { role: "assistant", content: "earlier answer" },
        ],
      },
      { factory: scriptedFactory(), clock: () => 0 },
    );
    expect(result.controller_event_chain_valid).toBe(true);
    expect(result.primary_output).toBe("The answer is 42.");
  });

  it("returns a resumable v2 checkpoint the orchestrator accepts", async () => {
    const provider = DeepSeekConfig.fromPayload(validProvider());
    const result = await runStudioGraph(
      { task: "What is the answer?", provider, conversation: [] },
      { factory: scriptedFactory(), clock: () => 0, storage: new InMemoryStorage() },
    );
    expect(typeof result.checkpoint).toBe("string");
    const parsed = parseResumableCheckpoint(result.checkpoint);
    expect(parsed.finalSnapshot.runId).toBe(result.snapshot["runId"]);
  });

  it("keeps the legacy storage option compatible for injected native runners", async () => {
    const provider = DeepSeekConfig.fromPayload(validProvider());
    const result = await runStudioGraph(
      { task: "What is the answer?", provider, conversation: [] },
      { factory: scriptedFactory(), clock: () => 0, storage: new InMemoryStorage() },
    );
    expect(result.primary_output).toBe("The answer is 42.");
  });
});

describe("runResume", () => {
  it("resumes from a v2 checkpoint and returns a StudioResult", async () => {
    const provider = DeepSeekConfig.fromPayload(validProvider());
    const first = await runStudioGraph(
      { task: "What is the answer?", provider, conversation: [] },
      { factory: scriptedFactory(), clock: () => 0, storage: new InMemoryStorage() },
    );

    const resumed = await runResume(first.checkpoint, provider, {
      storage: new InMemoryStorage(),
      factory: scriptedFactory(),
      clock: () => 0,
    });
    expect(resumed.controller_event_chain_valid).toBe(true);
    expect(resumed.snapshot["runId"]).toBe(first.snapshot["runId"]);
    expect(typeof resumed.checkpoint).toBe("string");
    expect(() => parseResumableCheckpoint(resumed.checkpoint)).not.toThrow();
  });
});
