import { describe, expect, it } from "vitest";
import { createAgentIdentity } from "@graph-agent/core";
import { InMemoryStorage } from "../src/storage.js";
import {
  createSessionDoc,
  readSessionDoc,
  writeSessionDoc,
} from "../src/session-doc.js";

function makeIdentity() {
  return createAgentIdentity({ nodeId: "n1", name: "planner", role: "root" });
}

describe("createSessionDoc", () => {
  it("应用默认值:schemaVersion=1、metadata={}", () => {
    const doc = createSessionDoc({
      sessionId: "s1",
      agentIdentity: makeIdentity(),
      createdAt: 0,
    });
    expect(doc.schemaVersion).toBe(1);
    expect(doc.metadata).toEqual({});
  });

  it("返回冻结的文档,metadata 亦冻结", () => {
    const doc = createSessionDoc({
      sessionId: "s1",
      agentIdentity: makeIdentity(),
      createdAt: 5,
      metadata: { k: "v" },
    });
    expect(Object.isFrozen(doc)).toBe(true);
    expect(Object.isFrozen(doc.metadata)).toBe(true);
  });

  it("拒绝空 sessionId", () => {
    expect(() =>
      createSessionDoc({
        sessionId: "",
        agentIdentity: makeIdentity(),
        createdAt: 0,
      }),
    ).toThrow();
  });

  it("拒绝负数 createdAt", () => {
    expect(() =>
      createSessionDoc({
        sessionId: "s1",
        agentIdentity: makeIdentity(),
        createdAt: -1,
      }),
    ).toThrow();
  });
});

describe("writeSessionDoc / readSessionDoc", () => {
  it("经 InMemoryStorage 往返后深度相等(含 agentIdentity)", async () => {
    const storage = new InMemoryStorage();
    const doc = createSessionDoc({
      sessionId: "s1",
      agentIdentity: makeIdentity(),
      createdAt: 42,
      metadata: { region: "us", n: 3 },
    });
    await writeSessionDoc(storage, "s1", doc);
    const loaded = await readSessionDoc(storage, "s1");
    expect(loaded).toEqual(doc);
    expect(loaded.agentIdentity).toEqual(doc.agentIdentity);
  });

  it("写入 sessions/${sessionId}/session.json", async () => {
    const storage = new InMemoryStorage();
    const doc = createSessionDoc({
      sessionId: "abc",
      agentIdentity: makeIdentity(),
      createdAt: 1,
    });
    await writeSessionDoc(storage, "abc", doc);
    expect(await storage.exists("sessions/abc/session.json")).toBe(true);
  });

  it("读回的文档是冻结/校验后的(不返回裸解析对象)", async () => {
    const storage = new InMemoryStorage();
    const doc = createSessionDoc({
      sessionId: "s1",
      agentIdentity: makeIdentity(),
      createdAt: 7,
    });
    await writeSessionDoc(storage, "s1", doc);
    const loaded = await readSessionDoc(storage, "s1");
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded.agentIdentity)).toBe(true);
  });
});
