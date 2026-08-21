import { describe, expect, it } from "vitest";
import { InMemoryStorage, type Storage } from "@graph-agent/session";
import { parseResumableCheckpoint } from "@graph-agent/orchestrator";
import { ScriptedModel, createModelResponse } from "@graph-agent/adapter";
import { AgentNode, type AgentSpec } from "@graph-agent/node";
import type { NodeFactory } from "@graph-agent/orchestrator";
import { CheckpointStore } from "../src/checkpoint-store.js";
import { DeepSeekConfig, runStudioGraph } from "../src/studio.js";

const VALID_KEY = "sk-abcdefgh1234";

function validProvider(): DeepSeekConfig {
  return DeepSeekConfig.fromPayload({
    type: "deepseek",
    api_key: VALID_KEY,
    model: "deepseek-v4-flash",
  });
}

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

/** Produce a real v2 checkpoint JSON string by running the studio graph. */
async function makeCheckpoint(storage: Storage): Promise<string> {
  const result = await runStudioGraph(
    { task: "What is the answer?", provider: validProvider(), conversation: [] },
    { factory: scriptedFactory(), clock: () => 0, storage },
  );
  return result.checkpoint;
}

describe("CheckpointStore", () => {
  it("saves a real v2 checkpoint and returns {id, meta}", async () => {
    const storage = new InMemoryStorage();
    const json = await makeCheckpoint(storage);
    const store = new CheckpointStore({ storage: new InMemoryStorage(), clock: () => 7 });

    const { id, meta } = await store.save(json);
    expect(id.length).toBeGreaterThan(0);
    expect(meta.id).toBe(id);
    expect(meta.createdAt).toBe(7);
    expect(meta.eventCount).toBeGreaterThan(0);
    expect(meta.nodeCount).toBeGreaterThan(0);
    expect(typeof meta.runId).toBe("string");
    expect(typeof meta.status).toBe("string");
    // The stored json round-trips through the orchestrator parser.
    expect(() => parseResumableCheckpoint(json)).not.toThrow();
  });

  it("lists saved checkpoints", async () => {
    const storage = new InMemoryStorage();
    const json = await makeCheckpoint(storage);
    const store = new CheckpointStore({ storage: new InMemoryStorage() });

    const { id } = await store.save(json);
    const list = await store.list();
    expect(list.some((m) => m.id === id)).toBe(true);
  });

  it("loads a stored checkpoint by id", async () => {
    const storage = new InMemoryStorage();
    const json = await makeCheckpoint(storage);
    const store = new CheckpointStore({ storage: new InMemoryStorage() });

    const { id } = await store.save(json);
    expect(await store.load(id)).toBe(json);
  });

  it("is idempotent: duplicate save returns the same id and does not double the index", async () => {
    const storage = new InMemoryStorage();
    const json = await makeCheckpoint(storage);
    const store = new CheckpointStore({ storage: new InMemoryStorage() });

    const first = await store.save(json);
    const second = await store.save(json);
    expect(second.id).toBe(first.id);
    const list = await store.list();
    expect(list.filter((m) => m.id === first.id)).toHaveLength(1);
  });

  it("throws when loading an absent id", async () => {
    const store = new CheckpointStore({ storage: new InMemoryStorage() });
    await expect(store.load("nope")).rejects.toThrow();
  });

  it("throws (fail-closed) when saving a bogus checkpoint", async () => {
    const store = new CheckpointStore({ storage: new InMemoryStorage() });
    await expect(store.save("not a checkpoint")).rejects.toThrow();
    await expect(store.save(JSON.stringify({ schemaVersion: 1 }))).rejects.toThrow();
  });
});
