import { describe, expect, it } from "vitest";
import { GENESIS_HASH } from "@graph-agent/core";
import { InMemoryStorage } from "../src/storage.js";
import {
  appendMessage,
  readMessages,
  verifyMessageChain,
  type StoredMessage,
} from "../src/message-store.js";

const SESSION_ID = "s-1";

describe("MessageStore", () => {
  it("chains two messages from GENESIS", async () => {
    const storage = new InMemoryStorage();
    const first = await appendMessage(storage, SESSION_ID, {
      role: "user",
      content: "hello",
    });
    expect(first.sequence).toBe(0);
    expect(first.previousHash).toBe(GENESIS_HASH);
    expect(first.toolCallsJson).toBe("[]");

    const second = await appendMessage(storage, SESSION_ID, {
      role: "assistant",
      content: "hi there",
      toolCalls: [{ name: "search", args: { q: "x" } }],
    });
    expect(second.sequence).toBe(1);
    expect(second.previousHash).toBe(first.entryHash);
    expect(second.toolCallsJson).not.toBe("[]");
  });

  it("readMessages round-trips what append returned", async () => {
    const storage = new InMemoryStorage();
    const first = await appendMessage(storage, SESSION_ID, {
      role: "user",
      content: "a",
    });
    const second = await appendMessage(storage, SESSION_ID, {
      role: "assistant",
      content: "b",
    });
    const read = await readMessages(storage, SESSION_ID);
    expect(read).toEqual([first, second]);
  });

  it("verifyMessageChain is true for a valid read chain", async () => {
    const storage = new InMemoryStorage();
    await appendMessage(storage, SESSION_ID, { role: "user", content: "a" });
    await appendMessage(storage, SESSION_ID, { role: "assistant", content: "b" });
    await appendMessage(storage, SESSION_ID, { role: "tool", content: "c" });
    const read = await readMessages(storage, SESSION_ID);
    expect(verifyMessageChain(read)).toBe(true);
  });

  it("detects tampered content", async () => {
    const storage = new InMemoryStorage();
    await appendMessage(storage, SESSION_ID, { role: "user", content: "a" });
    await appendMessage(storage, SESSION_ID, { role: "assistant", content: "b" });
    const read = await readMessages(storage, SESSION_ID);
    const tampered: StoredMessage[] = read.map((m, i) =>
      i === 1 ? { ...m, content: "TAMPERED" } : m,
    );
    expect(verifyMessageChain(tampered)).toBe(false);
  });

  it("detects a broken previousHash link", async () => {
    const storage = new InMemoryStorage();
    await appendMessage(storage, SESSION_ID, { role: "user", content: "a" });
    await appendMessage(storage, SESSION_ID, { role: "assistant", content: "b" });
    const read = await readMessages(storage, SESSION_ID);
    const broken: StoredMessage[] = read.map((m, i) =>
      i === 1 ? { ...m, previousHash: GENESIS_HASH } : m,
    );
    expect(verifyMessageChain(broken)).toBe(false);
  });

  it("empty log reads [] and verifies true", async () => {
    const storage = new InMemoryStorage();
    const read = await readMessages(storage, SESSION_ID);
    expect(read).toEqual([]);
    expect(verifyMessageChain([])).toBe(true);
  });

  it("rejects an invalid role (fail-closed)", async () => {
    const storage = new InMemoryStorage();
    await expect(
      appendMessage(storage, SESSION_ID, {
        role: "bogus" as unknown as "user",
        content: "x",
      }),
    ).rejects.toThrow();
  });
});
