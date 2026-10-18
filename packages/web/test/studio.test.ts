import { describe, expect, it } from "vitest";
import { createModelResponse, ScriptedModel } from "@graph-agent/adapter";
import { AgentNode, type AgentSpec } from "@graph-agent/node";
import type { NodeFactory } from "@graph-agent/orchestrator";
import { parseResumableCheckpoint } from "@graph-agent/orchestrator";
import { InMemoryStorage } from "@graph-agent/session";
import { createAgentIdentity, createNodeBudget } from "@graph-agent/core";
import {
  ProviderConfig,
  parseConversation,
  providerFactory,
  runResume,
  runStudioGraph,
  type StudioNodeResult,
} from "../src/studio.js";

const VALID_KEY = "sk-abcdefgh1234";

function validProvider(): Record<string, unknown> {
  return { type: "deepseek", api_key: VALID_KEY, model: "deepseek-v4-flash" };
}

describe("ProviderConfig.fromPayload", () => {
  it("accepts a valid payload", () => {
    const cfg = ProviderConfig.fromPayload(validProvider());
    expect(cfg.type).toBe("deepseek");
    expect(cfg.apiKey).toBe(VALID_KEY);
    expect(cfg.model).toBe("deepseek-v4-flash");
  });

  it("rejects non-object", () => {
    expect(() => ProviderConfig.fromPayload("nope")).toThrow();
    expect(() => ProviderConfig.fromPayload(null)).toThrow();
    expect(() => ProviderConfig.fromPayload([])).toThrow();
  });

  it("rejects extra or missing keys", () => {
    expect(() => ProviderConfig.fromPayload({ ...validProvider(), extra: 1 })).toThrow();
    expect(() => ProviderConfig.fromPayload({ type: "deepseek", api_key: VALID_KEY })).toThrow();
  });

  it("rejects an unregistered provider type", () => {
    expect(() => ProviderConfig.fromPayload({ ...validProvider(), type: "nope" })).toThrow(
      /provider\.type must be one of/,
    );
    expect(() => ProviderConfig.fromPayload({ ...validProvider(), type: 42 })).toThrow();
    // Inherited Object members must not resolve as providers.
    expect(() => ProviderConfig.fromPayload({ ...validProvider(), type: "constructor" })).toThrow();
  });

  it("accepts every registered provider type", () => {
    for (const type of ["deepseek", "qwen", "glm", "kimi", "doubao", "openai", "anthropic"]) {
      const cfg = ProviderConfig.fromPayload({ ...validProvider(), type, model: "m-1" });
      expect(cfg.type).toBe(type);
      expect(cfg.model).toBe("m-1");
    }
  });

  it("rejects api_key that is too short or too long", () => {
    expect(() => ProviderConfig.fromPayload({ ...validProvider(), api_key: "short" })).toThrow();
    expect(() =>
      ProviderConfig.fromPayload({ ...validProvider(), api_key: "x".repeat(1025) }),
    ).toThrow();
  });

  it("rejects api_key with whitespace or control chars", () => {
    expect(() => ProviderConfig.fromPayload({ ...validProvider(), api_key: " abcdefgh " })).toThrow();
    // A literal control char (vertical tab) is not printable ASCII.
    expect(() =>
      ProviderConfig.fromPayload({ ...validProvider(), api_key: "abcdef\u000bgh" }),
    ).toThrow(/printable ASCII/);
    expect(() => ProviderConfig.fromPayload({ ...validProvider(), api_key: 12345678 })).toThrow();
  });

  it("rejects a malformed model id but allows unknown ones", () => {
    // Upstream model ids churn, so an unfamiliar id is fine...
    expect(ProviderConfig.fromPayload({ ...validProvider(), model: "gpt-4" }).model).toBe("gpt-4");
    // ...including an Ark `ep-*` inference endpoint id.
    expect(
      ProviderConfig.fromPayload({ ...validProvider(), type: "doubao", model: "ep-20250101-abcde" })
        .model,
    ).toBe("ep-20250101-abcde");
    // ...but the format is still enforced.
    expect(() => ProviderConfig.fromPayload({ ...validProvider(), model: "has space" })).toThrow();
    expect(() => ProviderConfig.fromPayload({ ...validProvider(), model: "" })).toThrow();
    expect(() => ProviderConfig.fromPayload({ ...validProvider(), model: "a".repeat(129) })).toThrow();
  });

  it("requires base_url for local and forbids it elsewhere", () => {
    const local = ProviderConfig.fromPayload({
      type: "local",
      model: "qwen3:8b",
      base_url: "http://127.0.0.1:11434/v1",
    });
    expect(local.type).toBe("local");
    expect(local.baseUrl).toBe("http://127.0.0.1:11434/v1");
    // local has no default endpoint, so omitting base_url is an error.
    expect(() => ProviderConfig.fromPayload({ type: "local", model: "qwen3:8b" })).toThrow(
      /base_url is required/,
    );
    // Providers with a registry endpoint must not be redirected.
    expect(() =>
      ProviderConfig.fromPayload({ ...validProvider(), base_url: "https://evil.example.com/v1" }),
    ).toThrow(/not allowed/);
  });

  it("rejects a malformed local base_url at validation time", () => {
    // These must fail as payload errors (400), not later as run failures (502).
    for (const base_url of [
      "http://evil.example.com/v1", // plaintext to a non-loopback host
      "ftp://127.0.0.1/v1", // wrong scheme
      "https://user:pw@example.com/v1", // embedded credentials
      "https://example.com/v1?k=1", // query string
      "not a url",
    ]) {
      expect(() =>
        ProviderConfig.fromPayload({ type: "local", model: "m", base_url }),
      ).toThrow(/base_url is invalid/);
    }
    // Loopback over plain http stays allowed for local runtimes.
    expect(
      ProviderConfig.fromPayload({
        type: "local",
        model: "m",
        base_url: "http://localhost:11434/v1",
      }).baseUrl,
    ).toBe("http://localhost:11434/v1");
  });

  it("lets local omit the api key but still validates a supplied one", () => {
    const anon = ProviderConfig.fromPayload({
      type: "local",
      model: "qwen3:8b",
      base_url: "http://127.0.0.1:11434/v1",
    });
    expect(anon.apiKey).toBe("");
    expect(() =>
      ProviderConfig.fromPayload({
        type: "local",
        model: "qwen3:8b",
        base_url: "http://127.0.0.1:11434/v1",
        api_key: "short",
      }),
    ).toThrow();
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

/**
 * The real (non-injected) factory dispatch: DeepSeek must get the isolated
 * Harness runtime, every other provider an AgentNode over an OpenAI-compatible
 * adapter. Both satisfy NodeRunner, so we assert on the concrete class — that
 * distinction is the whole point of the registry.
 */
describe("providerFactory dispatch", () => {
  const spec = {
    identity: createAgentIdentity({
      nodeId: "root",
      name: "Orchestrator",
      role: "orchestrator",
      generation: 0,
    }),
    budget: createNodeBudget({
      maxTurns: 2,
      maxToolCalls: 2,
      maxTotalTokens: 1000,
      timeoutSeconds: 30,
    }),
    role: "orchestrator",
  };

  function runnerFor(payload: Record<string, unknown>) {
    const provider = ProviderConfig.fromPayload(payload);
    return providerFactory(provider).create({ spec, toolNames: [] });
  }

  it("routes deepseek to the isolated Harness runtime", () => {
    const runner = runnerFor(validProvider());
    expect(runner.constructor.name).toBe("DeepSeekHarnessNode");
  });

  it("routes other providers to AgentNode over an OpenAI-compatible adapter", () => {
    for (const type of ["qwen", "glm", "kimi", "doubao", "openai", "anthropic"]) {
      const runner = runnerFor({ ...validProvider(), type, model: "m-1" });
      expect(runner.constructor.name).toBe("AgentNode");
    }
  });

  it("routes local to AgentNode without requiring an api key", () => {
    const runner = runnerFor({
      type: "local",
      model: "qwen3:8b",
      base_url: "http://127.0.0.1:11434/v1",
    });
    expect(runner.constructor.name).toBe("AgentNode");
  });
});

describe("runStudioGraph", () => {
  it("drives the controller and returns a StudioResult", async () => {
    const provider = ProviderConfig.fromPayload(validProvider());
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
      endpoint: "https://api.deepseek.com/v1",
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
    const provider = ProviderConfig.fromPayload(validProvider());
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
    const provider = ProviderConfig.fromPayload(validProvider());
    const result = await runStudioGraph(
      { task: "What is the answer?", provider, conversation: [] },
      { factory: scriptedFactory(), clock: () => 0, storage: new InMemoryStorage() },
    );
    expect(typeof result.checkpoint).toBe("string");
    const parsed = parseResumableCheckpoint(result.checkpoint);
    expect(parsed.finalSnapshot.runId).toBe(result.snapshot["runId"]);
  });

  it("keeps the legacy storage option compatible for injected native runners", async () => {
    const provider = ProviderConfig.fromPayload(validProvider());
    const result = await runStudioGraph(
      { task: "What is the answer?", provider, conversation: [] },
      { factory: scriptedFactory(), clock: () => 0, storage: new InMemoryStorage() },
    );
    expect(result.primary_output).toBe("The answer is 42.");
  });
});

describe("runResume", () => {
  it("resumes from a v2 checkpoint and returns a StudioResult", async () => {
    const provider = ProviderConfig.fromPayload(validProvider());
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
