import { describe, expect, it } from "vitest";
import { InMemoryStorage } from "@graph-agent/session";
import {
  DEFAULT_TRUST,
  TRUST_TABLE_PATH,
  applyTrustObservations,
  createTrustTable,
  deserializeTrustTable,
  loadTrustTable,
  saveTrustTable,
  serializeTrustTable,
  trustForRole,
  updateTrust,
  updateTrustBatch,
} from "../src/trust.js";

describe("createTrustTable", () => {
  it("starts empty and reports DEFAULT_TRUST for unseen roles", () => {
    const table = createTrustTable();
    expect(table.size).toBe(0);
    expect(trustForRole(table, "researcher")).toBe(DEFAULT_TRUST);
    expect(DEFAULT_TRUST).toBe(1);
  });

  it("accepts seed entries and rejects out-of-range values", () => {
    expect(trustForRole(createTrustTable({ writer: 0.4 }), "writer")).toBe(0.4);
    expect(() => createTrustTable({ writer: 1.5 })).toThrow();
    expect(() => createTrustTable({ writer: -0.1 })).toThrow();
  });
});

describe("updateTrust", () => {
  it("applies the EMA from trust.ts: (1-a)*prior + a*reward", () => {
    const table = createTrustTable({ worker: 0.5 });
    const next = updateTrust(table, { role: "worker", reward: 1 }, 0.2);
    expect(trustForRole(next, "worker")).toBeCloseTo(0.6, 10);
  });

  it("starts an unseen role from DEFAULT_TRUST so a bad first showing drops it", () => {
    const next = updateTrust(createTrustTable(), { role: "new", reward: 0 }, 0.3);
    // (1-0.3)*1 + 0.3*0 = 0.7 — 立刻下降,而不是从 0 往上爬。
    expect(trustForRole(next, "new")).toBeCloseTo(0.7, 10);
  });

  it("does not mutate the input table", () => {
    const table = createTrustTable({ worker: 0.5 });
    updateTrust(table, { role: "worker", reward: 0 }, 0.5);
    expect(trustForRole(table, "worker")).toBe(0.5);
  });

  it("leaves other roles untouched", () => {
    const table = createTrustTable({ a: 0.2, b: 0.8 });
    const next = updateTrust(table, { role: "a", reward: 1 }, 0.5);
    expect(trustForRole(next, "b")).toBe(0.8);
  });

  it("stays inside the unit interval at the extremes", () => {
    const low = updateTrust(createTrustTable({ r: 0 }), { role: "r", reward: 0 }, 1);
    expect(trustForRole(low, "r")).toBe(0);
    const high = updateTrust(createTrustTable({ r: 1 }), { role: "r", reward: 1 }, 1);
    expect(trustForRole(high, "r")).toBe(1);
  });

  it("rejects an out-of-range alpha or reward", () => {
    const table = createTrustTable();
    expect(() => updateTrust(table, { role: "r", reward: 2 }, 0.5)).toThrow();
    expect(() => updateTrust(table, { role: "r", reward: 0.5 }, 1.5)).toThrow();
  });

  it("converges toward a constant reward under repeated updates", () => {
    let table = createTrustTable({ r: 1 });
    for (let i = 0; i < 200; i += 1) {
      table = updateTrust(table, { role: "r", reward: 0.25 }, 0.1);
    }
    expect(trustForRole(table, "r")).toBeCloseTo(0.25, 6);
  });
});

describe("updateTrustBatch", () => {
  it("is deterministic regardless of input order for distinct roles", () => {
    const a = updateTrustBatch(
      createTrustTable(),
      [
        { role: "writer", reward: 0.2 },
        { role: "reviewer", reward: 0.9 },
      ],
      0.5,
    );
    const b = updateTrustBatch(
      createTrustTable(),
      [
        { role: "reviewer", reward: 0.9 },
        { role: "writer", reward: 0.2 },
      ],
      0.5,
    );
    expect(serializeTrustTable(a)).toBe(serializeTrustTable(b));
  });

  it("preserves within-role order because the EMA does not commute", () => {
    // 同一角色两次观测:EMA 不可交换,故必须按入参相对顺序处理。
    const table = updateTrustBatch(
      createTrustTable({ r: 1 }),
      [
        { role: "r", reward: 0 },
        { role: "r", reward: 1 },
      ],
      0.5,
    );
    // 1 → 0.5 → 0.75
    expect(trustForRole(table, "r")).toBeCloseTo(0.75, 10);
    const reversed = updateTrustBatch(
      createTrustTable({ r: 1 }),
      [
        { role: "r", reward: 1 },
        { role: "r", reward: 0 },
      ],
      0.5,
    );
    // 1 → 1 → 0.5
    expect(trustForRole(reversed, "r")).toBeCloseTo(0.5, 10);
  });

  it("returns the table unchanged for no observations", () => {
    const table = createTrustTable({ r: 0.3 });
    expect(serializeTrustTable(updateTrustBatch(table, [], 0.5))).toBe(
      serializeTrustTable(table),
    );
  });
});

describe("serialize / deserialize", () => {
  it("round-trips", () => {
    const table = createTrustTable({ writer: 0.25, reviewer: 0.75 });
    const restored = deserializeTrustTable(serializeTrustTable(table));
    expect(trustForRole(restored, "writer")).toBe(0.25);
    expect(trustForRole(restored, "reviewer")).toBe(0.75);
  });

  it("is canonical: role key order does not affect the bytes", () => {
    const a = createTrustTable({ b: 0.5, a: 0.5 });
    const b = createTrustTable({ a: 0.5, b: 0.5 });
    expect(serializeTrustTable(a)).toBe(serializeTrustTable(b));
  });

  it("fails closed on a bad schema version, shape, or value", () => {
    expect(() => deserializeTrustTable('{"schemaVersion":2,"roles":{}}')).toThrow(
      "unsupported trust table schemaVersion",
    );
    expect(() => deserializeTrustTable('{"schemaVersion":1}')).toThrow();
    expect(() => deserializeTrustTable('{"schemaVersion":1,"roles":[]}')).toThrow();
    expect(() =>
      deserializeTrustTable('{"schemaVersion":1,"roles":{"r":"high"}}'),
    ).toThrow();
    expect(() => deserializeTrustTable('{"schemaVersion":1,"roles":{"r":1.5}}')).toThrow();
    expect(() => deserializeTrustTable("[]")).toThrow();
  });
});

describe("persistence across runs", () => {
  it("loads an absent table as empty", async () => {
    const storage = new InMemoryStorage();
    const table = await loadTrustTable(storage);
    expect(table.size).toBe(0);
  });

  it("round-trips through storage", async () => {
    const storage = new InMemoryStorage();
    await saveTrustTable(storage, createTrustTable({ worker: 0.4 }));
    expect(await storage.exists(TRUST_TABLE_PATH)).toBe(true);
    const table = await loadTrustTable(storage);
    expect(trustForRole(table, "worker")).toBe(0.4);
  });

  it("accumulates across separate load/modify/save cycles", async () => {
    // 这是跨运行学习的核心路径:每次「运行」后施加一批观测,下次运行读到的是
    // 累积结果。节点级运行内学习由构造不可能,故学习只能发生在这里。
    const storage = new InMemoryStorage();
    await applyTrustObservations(storage, [{ role: "flaky", reward: 0 }], 0.5);
    expect(trustForRole(await loadTrustTable(storage), "flaky")).toBeCloseTo(0.5, 10);
    await applyTrustObservations(storage, [{ role: "flaky", reward: 0 }], 0.5);
    expect(trustForRole(await loadTrustTable(storage), "flaky")).toBeCloseTo(0.25, 10);
    await applyTrustObservations(storage, [{ role: "flaky", reward: 0 }], 0.5);
    expect(trustForRole(await loadTrustTable(storage), "flaky")).toBeCloseTo(0.125, 10);
  });

  it("does not lose updates under concurrent read-modify-write", async () => {
    // 无锁的读—改—写会丢更新;applyTrustObservations 整体持锁。
    const storage = new InMemoryStorage();
    await Promise.all(
      Array.from({ length: 8 }, () =>
        applyTrustObservations(storage, [{ role: "r", reward: 0 }], 0.5),
      ),
    );
    // 8 次 reward=0、alpha=0.5 的更新:1 * 0.5^8 = 0.00390625
    expect(trustForRole(await loadTrustTable(storage), "r")).toBeCloseTo(
      Math.pow(0.5, 8),
      10,
    );
  });

  it("keeps distinct roles independent through storage", async () => {
    const storage = new InMemoryStorage();
    await applyTrustObservations(
      storage,
      [
        { role: "good", reward: 1 },
        { role: "bad", reward: 0 },
      ],
      0.5,
    );
    const table = await loadTrustTable(storage);
    expect(trustForRole(table, "good")).toBe(1);
    expect(trustForRole(table, "bad")).toBeCloseTo(0.5, 10);
  });
});
