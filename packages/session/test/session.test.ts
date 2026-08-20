import { describe, expect, it } from "vitest";
import {
  NodeStatus,
  createAgentIdentity,
  createAgentInput,
  createAgentResult,
  createUsage,
} from "@graph-agent/core";
import { InMemoryStorage } from "../src/storage.js";
import { Session } from "../src/session.js";
import { readMessages } from "../src/message-store.js";

const SESSION_ID = "s-1";
const clock = () => 42;

function makeIdentity() {
  return createAgentIdentity({ nodeId: "n1", name: "planner", role: "root" });
}

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

describe("Session facade", () => {
  it("open writes the SessionDoc and load round-trips it", async () => {
    const storage = new InMemoryStorage();
    await Session.open(storage, SESSION_ID, makeIdentity(), 7);
    expect(await storage.exists(`sessions/${SESSION_ID}/session.json`)).toBe(true);

    // load must succeed once the doc exists.
    const loaded = await Session.load(storage, SESSION_ID);
    expect(loaded).toBeInstanceOf(Session);
  });

  it("load throws (fail-closed) when the SessionDoc is absent", async () => {
    const storage = new InMemoryStorage();
    await expect(Session.load(storage, "missing")).rejects.toThrow();
  });

  it("appendMessage then readMessages returns the message", async () => {
    const storage = new InMemoryStorage();
    const session = await Session.open(storage, SESSION_ID, makeIdentity(), 0);
    await session.appendMessage({ role: "user", content: "hello" });
    const messages = await session.readMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]!.role).toBe("user");
    expect(messages[0]!.content).toBe("hello");
  });

  it("startRun / finishRun cycle flips running -> idle", async () => {
    const storage = new InMemoryStorage();
    const session = await Session.open(storage, SESSION_ID, makeIdentity(), 0);

    const runId = await session.startRun(makeInput(), 0, clock);
    expect(runId).toMatch(/^[0-9a-f]{64}$/);
    expect((await session.readRuntime()).status).toBe("running");

    await session.finishRun(runId, makeResult("n-1"), clock);
    const state = await session.readRuntime();
    expect(state.status).toBe("idle");
    expect(state.activeRunId).toBeNull();
  });

  it("openWork / settleWork: openWorkItems reflects open then settled", async () => {
    const storage = new InMemoryStorage();
    const session = await Session.open(storage, SESSION_ID, makeIdentity(), 0);

    const workId = await session.openWork("corr-1", { payload: 1 }, 0);
    expect(await session.openWorkItems()).toContain(workId);

    await session.settleWork(workId, { ok: true });
    expect(await session.openWorkItems()).not.toContain(workId);
  });

  it("deliver puts the message into history AND creates a receipt", async () => {
    const storage = new InMemoryStorage();
    const session = await Session.open(storage, SESSION_ID, makeIdentity(), 0);

    const result = await session.deliver(
      "msg-1",
      { from: "other", body: "hi" },
      { role: "assistant", content: "delivered body" },
    );
    expect(result).toBe("accepted");

    const messages = await session.readMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toBe("delivered body");
    expect(await session.deliveryStatus("msg-1")).toBe("delivered");
  });

  it("deliver same messageId twice: second is duplicate and does not double-append", async () => {
    const storage = new InMemoryStorage();
    const session = await Session.open(storage, SESSION_ID, makeIdentity(), 0);

    const first = await session.deliver(
      "msg-1",
      { from: "other", body: "hi" },
      { role: "assistant", content: "body" },
    );
    expect(first).toBe("accepted");
    expect(await session.readMessages()).toHaveLength(1);

    const second = await session.deliver(
      "msg-1",
      { from: "other", body: "hi" },
      { role: "assistant", content: "body" },
    );
    expect(second).toBe("duplicate");
    // Count unchanged: no double-append.
    expect(await session.readMessages()).toHaveLength(1);
    // History chain still intact after everything.
    const stored = await readMessages(storage, SESSION_ID);
    expect(stored).toHaveLength(1);
  });
});
