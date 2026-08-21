import { describe, it, expect } from "vitest";
import { InMemoryStorage, readMessages } from "@graph-agent/session";
import { createMessage } from "@graph-agent/adapter";
import { SessionBackedMemory } from "../src/index.js";

describe("SessionBackedMemory", () => {
  it("appends then loads messages with roles preserved", async () => {
    const storage = new InMemoryStorage();
    const mem = new SessionBackedMemory({ storage });
    await mem.append({
      nodeId: "n1",
      sessionId: "run1",
      messages: [
        createMessage({ role: "user", content: "hi" }),
        createMessage({ role: "assistant", content: "yo" }),
      ],
    });
    const loaded = await mem.load({ nodeId: "n1", sessionId: "run1" });
    expect(loaded.map((m) => [m.role, m.content])).toEqual([
      ["user", "hi"],
      ["assistant", "yo"],
    ]);
  });

  it("maps adapter context role to user when persisting", async () => {
    const storage = new InMemoryStorage();
    const mem = new SessionBackedMemory({ storage });
    await mem.append({
      nodeId: "n1",
      sessionId: "run1",
      messages: [createMessage({ role: "context", content: "Untrusted context from node x" })],
    });
    const loaded = await mem.load({ nodeId: "n1", sessionId: "run1" });
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.role).toBe("user");
    expect(loaded[0]!.content).toBe("Untrusted context from node x");
  });

  it("returns [] for an absent session", async () => {
    const storage = new InMemoryStorage();
    const mem = new SessionBackedMemory({ storage });
    const loaded = await mem.load({ nodeId: "nope", sessionId: "nope" });
    expect(loaded).toEqual([]);
  });

  it("keeps a valid hash chain and preserves order across appends", async () => {
    const storage = new InMemoryStorage();
    const mem = new SessionBackedMemory({ storage });
    await mem.append({
      nodeId: "n1",
      sessionId: "run1",
      messages: [
        createMessage({ role: "user", content: "one" }),
        createMessage({ role: "assistant", content: "two" }),
        createMessage({ role: "user", content: "three" }),
      ],
    });
    const loaded = await mem.load({ nodeId: "n1", sessionId: "run1" });
    expect(loaded.map((m) => m.content)).toEqual(["one", "two", "three"]);

    // Underlying store: 3 sequential entries forming an intact chain.
    const stored = await readMessages(storage, "run1::n1");
    expect(stored.map((s) => s.sequence)).toEqual([0, 1, 2]);
  });

  it("accumulates across two sequential appends", async () => {
    const storage = new InMemoryStorage();
    const mem = new SessionBackedMemory({ storage });
    await mem.append({
      nodeId: "n1",
      sessionId: "run1",
      messages: [createMessage({ role: "user", content: "a" })],
    });
    await mem.append({
      nodeId: "n1",
      sessionId: "run1",
      messages: [createMessage({ role: "assistant", content: "b" })],
    });
    const loaded = await mem.load({ nodeId: "n1", sessionId: "run1" });
    expect(loaded.map((m) => m.content)).toEqual(["a", "b"]);
  });

  it("coerces null content to empty string when persisting", async () => {
    const storage = new InMemoryStorage();
    const mem = new SessionBackedMemory({ storage });
    await mem.append({
      nodeId: "n1",
      sessionId: "run1",
      messages: [createMessage({ role: "assistant", content: null })],
    });
    const loaded = await mem.load({ nodeId: "n1", sessionId: "run1" });
    expect(loaded[0]!.content).toBe("");
  });
});
