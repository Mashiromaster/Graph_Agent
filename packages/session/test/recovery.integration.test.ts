import { describe, expect, it } from "vitest";
import {
  NodeStatus,
  canonicalJson,
  createAgentInput,
  createAgentResult,
  createUsage,
} from "@graph-agent/core";
import { InMemoryStorage } from "../src/storage.js";
import { recoverSession } from "../src/recovery.js";
import { appendMessage, readMessages, verifyMessageChain } from "../src/message-store.js";
import { startRun } from "../src/runtime.js";
import { openWork } from "../src/work-ledger.js";
import { putIfAbsent } from "../src/inbox.js";

const SESSION_ID = "s-rec";
const clock = () => 42;

function makeInput() {
  return createAgentInput({ task: "do the thing", sessionId: SESSION_ID });
}

function makeResult(nodeId: string) {
  return createAgentResult({
    nodeId,
    status: NodeStatus.COMPLETED,
    output: "done",
    usage: createUsage({ inputTokens: 1, outputTokens: 1 }),
    events: [],
  });
}

const messagesLogPath = (id: string) => `sessions/${id}/messages.log`;
const archivePath = (id: string, runId: string) => `sessions/${id}/runs/${runId}.json`;

describe("recoverSession crash recovery", () => {
  it("truncates a message log to the last intact entry after a mid-append crash", async () => {
    const storage = new InMemoryStorage();
    // Two well-formed entries.
    await appendMessage(storage, SESSION_ID, { role: "user", content: "a" });
    await appendMessage(storage, SESSION_ID, { role: "assistant", content: "b" });
    // Simulate a crash mid-append: a trailing corrupt/partial line lands in the log.
    await storage.appendLine(
      messagesLogPath(SESSION_ID),
      JSON.stringify({ sequence: 2, role: "user", content: "c", toolCallsJson: "[]", previousHash: "deadbeef", entryHash: "bogus" }),
    );

    // Full chain is now broken.
    expect(verifyMessageChain(await readMessages(storage, SESSION_ID))).toBe(false);

    const snapshot = await recoverSession(storage, SESSION_ID);
    expect(snapshot.messages).toHaveLength(2);
    expect(verifyMessageChain(snapshot.messages)).toBe(true);
    // The corrupt tail was NOT persisted-away: recovery is read-only.
    expect(await readMessages(storage, SESSION_ID)).toHaveLength(3);
  });

  it("reports interruptedRunId when running with no archived run file", async () => {
    const storage = new InMemoryStorage();
    const runId = await startRun(storage, SESSION_ID, makeInput(), 0, clock);
    // Crash after startRun, before any archive → runtime running, no runs/${runId}.json.
    expect(await storage.exists(archivePath(SESSION_ID, runId))).toBe(false);

    const snapshot = await recoverSession(storage, SESSION_ID);
    expect(snapshot.runtime.status).toBe("running");
    expect(snapshot.interruptedRunId).toBe(runId);
  });

  it("reconciles archived-but-running to NOT interrupted", async () => {
    const storage = new InMemoryStorage();
    const runId = await startRun(storage, SESSION_ID, makeInput(), 0, clock);
    // Simulate crash BETWEEN archive and idle-flip: write the archive but leave runtime running.
    await storage.createOnce(
      archivePath(SESSION_ID, runId),
      canonicalJson({
        nodeId: "n-1",
        status: NodeStatus.COMPLETED,
        output: "done",
        usage: makeResult("n-1").usage,
        error: null,
      }),
    );

    const snapshot = await recoverSession(storage, SESSION_ID);
    expect(snapshot.runtime.status).toBe("running");
    // Archived → the run actually finished → NOT interrupted.
    expect(snapshot.interruptedRunId).toBeNull();
  });

  it("lists open work after openWork before settle", async () => {
    const storage = new InMemoryStorage();
    const workId = await openWork(storage, SESSION_ID, "corr-1", { p: 1 }, 0);
    // Crash before settle.
    const snapshot = await recoverSession(storage, SESSION_ID);
    expect(snapshot.openWork).toContain(workId);
  });

  it("lists pending deliveries after history append but before receipt", async () => {
    const storage = new InMemoryStorage();
    // Envelope put, history appended, but receipt NOT written (crash between).
    const messageId = "msg-1";
    await putIfAbsent(storage, SESSION_ID, messageId, { body: "hi" });
    await appendMessage(storage, SESSION_ID, { role: "assistant", content: "hi" });
    // No receipt written.

    const snapshot = await recoverSession(storage, SESSION_ID);
    expect(snapshot.pendingDeliveries).toContain(messageId);
  });

  it("recover twice yields an identical snapshot (idempotent, read-only)", async () => {
    const storage = new InMemoryStorage();
    // Build a mixed state exercising every field.
    await appendMessage(storage, SESSION_ID, { role: "user", content: "a" });
    const runId = await startRun(storage, SESSION_ID, makeInput(), 0, clock);
    void runId;
    await openWork(storage, SESSION_ID, "corr-1", { p: 1 }, 0);
    await putIfAbsent(storage, SESSION_ID, "msg-1", { body: "x" });

    const first = await recoverSession(storage, SESSION_ID);
    const second = await recoverSession(storage, SESSION_ID);
    expect(second).toEqual(first);
  });
});
