/**
 * Offline end-to-end closed loop for the resumable checkpoint feature.
 *
 * Proves the full save/load/resume chain the Checkpoints UI relies on, using a
 * ScriptedModel-backed factory + InMemoryStorage (NO network, NO Date/random):
 *   runStudioGraph → StudioResult.checkpoint
 *     → CheckpointStore.save → CheckpointStore.load
 *       → runResume(loaded, provider, {storage, factory}) → converged StudioResult
 *
 * The store round-trip is the piece the two `studio.test.ts` cases skip (they
 * feed the in-memory checkpoint straight back into runResume). This test drives
 * the checkpoint THROUGH the durable store, mirroring what the server endpoints
 * (POST /api/checkpoints → GET /api/checkpoints/:id → POST /resume) do.
 */

import { describe, expect, it } from "vitest";
import { createModelResponse, ScriptedModel } from "@graph-agent/adapter";
import { AgentNode, type AgentSpec } from "@graph-agent/node";
import type { NodeFactory } from "@graph-agent/orchestrator";
import { parseResumableCheckpoint } from "@graph-agent/orchestrator";
import { InMemoryStorage } from "@graph-agent/session";
import { CheckpointStore } from "../src/checkpoint-store.js";
import { DeepSeekConfig, runResume, runStudioGraph } from "../src/studio.js";

function validProvider(): Record<string, unknown> {
  return { type: "deepseek", api_key: "sk-test-key-1234", model: "deepseek-v4-flash" };
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

describe("checkpoint save/load/resume closed loop (offline)", () => {
  it("runs → saves via store → loads via store → resumes to convergence", async () => {
    const provider = DeepSeekConfig.fromPayload(validProvider());
    const storage = new InMemoryStorage();
    const store = new CheckpointStore({ storage, clock: () => 0 });

    // 1) fresh run → StudioResult with a v2 checkpoint.
    const run = await runStudioGraph(
      { task: "What is the answer?", provider, conversation: [] },
      { factory: scriptedFactory(), clock: () => 0, storage: new InMemoryStorage() },
    );
    expect(typeof run.checkpoint).toBe("string");

    // 2) persist through the durable CheckpointStore (fail-closed parse inside).
    const { id, meta } = await store.save(run.checkpoint);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(meta.runId).toBe(run.snapshot["runId"]);

    // list reflects the saved checkpoint.
    const list = await store.list();
    expect(list.map((m) => m.id)).toContain(id);

    // 3) load it back out of the store (what GET /api/checkpoints/:id returns).
    const loaded = await store.load(id);
    expect(loaded).toBe(run.checkpoint);
    expect(() => parseResumableCheckpoint(loaded)).not.toThrow();

    // 4) resume the loaded checkpoint to convergence — a real resumed StudioResult.
    const resumed = await runResume(loaded, provider, {
      storage: new InMemoryStorage(),
      factory: scriptedFactory(),
      clock: () => 0,
    });
    expect(resumed.controller_event_chain_valid).toBe(true);
    expect(resumed.snapshot["runId"]).toBe(run.snapshot["runId"]);
    expect(resumed.snapshot["status"]).toBe("succeeded");
    expect(() => parseResumableCheckpoint(resumed.checkpoint)).not.toThrow();
  });
});
