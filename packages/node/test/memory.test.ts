import { createMessage } from "@graph-agent/adapter";
import { describe, expect, it } from "vitest";
import { InMemorySessionMemory } from "../src/memory.js";

describe("InMemorySessionMemory", () => {
  it("returns [] for an unknown key", async () => {
    const mem = new InMemorySessionMemory();
    expect(await mem.load({ nodeId: "n", sessionId: "s" })).toEqual([]);
  });

  it("appends then loads a frozen copy", async () => {
    const mem = new InMemorySessionMemory();
    const msg = createMessage({ role: "user", content: "hi" });
    await mem.append({ nodeId: "n", sessionId: "s", messages: [msg] });
    const loaded = await mem.load({ nodeId: "n", sessionId: "s" });
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.content).toBe("hi");
    expect(Object.isFrozen(loaded)).toBe(true);
  });

  it("isolates entries per key", async () => {
    const mem = new InMemorySessionMemory();
    await mem.append({
      nodeId: "a",
      sessionId: "s",
      messages: [createMessage({ role: "user", content: "for-a" })],
    });
    await mem.append({
      nodeId: "b",
      sessionId: "s",
      messages: [createMessage({ role: "user", content: "for-b" })],
    });
    const a = await mem.load({ nodeId: "a", sessionId: "s" });
    const b = await mem.load({ nodeId: "b", sessionId: "s" });
    expect(a.map((m) => m.content)).toEqual(["for-a"]);
    expect(b.map((m) => m.content)).toEqual(["for-b"]);
  });

  it("serializes two concurrent appends so both land", async () => {
    const mem = new InMemorySessionMemory();
    await Promise.all([
      mem.append({
        nodeId: "n",
        sessionId: "s",
        messages: [createMessage({ role: "user", content: "one" })],
      }),
      mem.append({
        nodeId: "n",
        sessionId: "s",
        messages: [createMessage({ role: "user", content: "two" })],
      }),
    ]);
    const loaded = await mem.load({ nodeId: "n", sessionId: "s" });
    expect(loaded).toHaveLength(2);
    expect(loaded.map((m) => m.content).sort()).toEqual(["one", "two"]);
  });
});
