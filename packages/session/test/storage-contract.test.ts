import { describe, expect, it } from "vitest";
import { InMemoryStorage, type Storage } from "../src/storage.js";

export function runStorageContract(makeStorage: (opts?: unknown) => Storage): void {
  it("atomicWrite then read round-trips", async () => {
    const s = makeStorage();
    await s.atomicWrite("a.json", '{"x":1}');
    expect(await s.read("a.json")).toBe('{"x":1}');
  });
  it("createOnce rejects a second write to the same path", async () => {
    const s = makeStorage();
    await s.createOnce("k", "v1");
    await expect(s.createOnce("k", "v2")).rejects.toThrow();
    expect(await s.read("k")).toBe("v1");
  });
  it("appendLine preserves order", async () => {
    const s = makeStorage();
    await s.appendLine("log", "one");
    await s.appendLine("log", "two");
    expect(await s.readLines("log")).toEqual(["one", "two"]);
  });
  it("withLock serializes critical sections", async () => {
    const s = makeStorage();
    let inside = 0, maxInside = 0;
    const crit = async () => { inside++; maxInside = Math.max(maxInside, inside); await Promise.resolve(); inside--; };
    await Promise.all([s.withLock("L", crit), s.withLock("L", crit)]);
    expect(maxInside).toBe(1);
  });
  it("atomicWrite leaves no half-written file on crash injection", async () => {
    const s = makeStorage({ crashAfter: 1 });
    await s.atomicWrite("a", "old");
    await expect(s.atomicWrite("a", "new-value")).rejects.toThrow();
    expect(await s.read("a")).toBe("old");
  });
}

describe("InMemoryStorage", () => runStorageContract((opts) => new InMemoryStorage(opts as never)));
