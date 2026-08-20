import { describe, expect, it } from "vitest";
import {
  NodeStatus,
  createAgentInput,
  createAgentResult,
  createUsage,
} from "@graph-agent/core";
import { InMemoryStorage } from "../src/storage.js";
import {
  IllegalRuntimeTransition,
  finishRun,
  readRuntime,
  startRun,
} from "../src/runtime.js";

const SESSION_ID = "s-1";
const clock = () => 42;

function makeInput() {
  return createAgentInput({ task: "do the thing", sessionId: SESSION_ID });
}

function makeResult(nodeId: string) {
  return createAgentResult({
    nodeId,
    status: NodeStatus.COMPLETED,
    output: "done",
    usage: createUsage({ inputTokens: 3, outputTokens: 5 }),
    events: [],
  });
}

describe("Runtime", () => {
  it("fresh session reads idle with null activeRunId", async () => {
    const storage = new InMemoryStorage();
    const state = await readRuntime(storage, SESSION_ID);
    expect(state.status).toBe("idle");
    expect(state.activeRunId).toBeNull();
    expect(state.updatedAt).toBe(0);
    expect(Object.isFrozen(state)).toBe(true);
  });

  it("startRun flips to running with the returned runId", async () => {
    const storage = new InMemoryStorage();
    const runId = await startRun(storage, SESSION_ID, makeInput(), 0, clock);
    expect(runId).toMatch(/^[0-9a-f]{64}$/);
    const state = await readRuntime(storage, SESSION_ID);
    expect(state.status).toBe("running");
    expect(state.activeRunId).toBe(runId);
    expect(state.updatedAt).toBe(42);
  });

  it("second startRun while running throws IllegalRuntimeTransition", async () => {
    const storage = new InMemoryStorage();
    await startRun(storage, SESSION_ID, makeInput(), 0, clock);
    await expect(
      startRun(storage, SESSION_ID, makeInput(), 1, clock),
    ).rejects.toBeInstanceOf(IllegalRuntimeTransition);
  });

  it("finishRun archives the result and returns to idle", async () => {
    const storage = new InMemoryStorage();
    const runId = await startRun(storage, SESSION_ID, makeInput(), 0, clock);
    await finishRun(storage, SESSION_ID, runId, makeResult("n-1"), clock);

    const state = await readRuntime(storage, SESSION_ID);
    expect(state.status).toBe("idle");
    expect(state.activeRunId).toBeNull();

    const archivePath = `sessions/${SESSION_ID}/runs/${runId}.json`;
    expect(await storage.exists(archivePath)).toBe(true);
    const archived = JSON.parse(await storage.read(archivePath)) as {
      nodeId: string;
      status: string;
      output: string | null;
    };
    expect(archived.nodeId).toBe("n-1");
    expect(archived.status).toBe(NodeStatus.COMPLETED);
    expect(archived.output).toBe("done");
  });

  it("can start a new run after finishing the previous one", async () => {
    const storage = new InMemoryStorage();
    const runId0 = await startRun(storage, SESSION_ID, makeInput(), 0, clock);
    await finishRun(storage, SESSION_ID, runId0, makeResult("n-0"), clock);
    const runId1 = await startRun(storage, SESSION_ID, makeInput(), 1, clock);
    expect(runId1).not.toBe(runId0);
    expect((await readRuntime(storage, SESSION_ID)).activeRunId).toBe(runId1);
  });

  it("double finishRun is idempotent: no throw, archive unchanged", async () => {
    const storage = new InMemoryStorage();
    const runId = await startRun(storage, SESSION_ID, makeInput(), 0, clock);
    await finishRun(storage, SESSION_ID, runId, makeResult("n-1"), clock);

    const archivePath = `sessions/${SESSION_ID}/runs/${runId}.json`;
    const firstArchive = await storage.read(archivePath);

    // Second finish with a DIFFERENT result must be a no-op (short-circuit).
    await expect(
      finishRun(storage, SESSION_ID, runId, makeResult("n-DIFFERENT"), clock),
    ).resolves.toBeUndefined();

    const secondArchive = await storage.read(archivePath);
    expect(secondArchive).toBe(firstArchive);
    expect((await readRuntime(storage, SESSION_ID)).status).toBe("idle");
  });
});
