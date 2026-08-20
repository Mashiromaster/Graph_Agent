import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "@graph-agent/core";
import { InMemoryStorage, FileStorage } from "../src/storage.js";
import type { Storage } from "../src/storage.js";
import { openWork, settleWork, openWorkItems, workExecutionId } from "../src/work-ledger.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeFileStorage(): FileStorage {
  const root = mkdtempSync(join(tmpdir(), "ga-work-"));
  dirs.push(root);
  return new FileStorage({ rootDir: root });
}

/** Shared behavioural contract run against both storages (same-semantics). */
function runWorkLedgerContract(makeStorage: () => Storage): void {
  const sid = "sess-1";

  it("lists both of two distinct works", async () => {
    const s = makeStorage();
    const w1 = await openWork(s, sid, "key-a", { n: 1 }, 0);
    const w2 = await openWork(s, sid, "key-b", { n: 2 }, 0);
    expect(w1).not.toBe(w2);
    const open = await openWorkItems(s, sid);
    expect([...open].sort()).toEqual([w1, w2].sort());
  });

  it("distinct seq for same correlationKey → distinct works", async () => {
    const s = makeStorage();
    const w0 = await openWork(s, sid, "key-a", { n: 1 }, 0);
    const w1 = await openWork(s, sid, "key-a", { n: 1 }, 1);
    expect(w0).not.toBe(w1);
    expect((await openWorkItems(s, sid)).length).toBe(2);
  });

  it("same (correlationKey, seq) twice → same workId, one open record", async () => {
    const s = makeStorage();
    const first = await openWork(s, sid, "key-a", { n: 1 }, 0);
    // Re-open with a DIFFERENT payload; must NOT throw and must NOT overwrite.
    const second = await openWork(s, sid, "key-a", { n: 999 }, 0);
    expect(second).toBe(first);
    const open = await openWorkItems(s, sid);
    expect(open).toEqual([first]);
    // First open record content wins (payload n:1, not n:999).
    const stored = JSON.parse(await s.read(`sessions/${sid}/work/${first}.open.json`));
    expect(stored.payloadJson).toBe(canonicalJson({ n: 1 }));
  });

  it("settleWork removes a work from openWorkItems", async () => {
    const s = makeStorage();
    const w1 = await openWork(s, sid, "key-a", { n: 1 }, 0);
    const w2 = await openWork(s, sid, "key-b", { n: 2 }, 0);
    await settleWork(s, sid, w1, { ok: true });
    expect(await openWorkItems(s, sid)).toEqual([w2]);
  });

  it("double settle is idempotent; first result content wins", async () => {
    const s = makeStorage();
    const w1 = await openWork(s, sid, "key-a", { n: 1 }, 0);
    await settleWork(s, sid, w1, { result: "first" });
    // Second settle with a DIFFERENT result must not throw or overwrite.
    await settleWork(s, sid, w1, { result: "second" });
    const stored = JSON.parse(await s.read(`sessions/${sid}/work/${w1}.settled.json`));
    expect(stored.resultJson).toBe(canonicalJson({ result: "first" }));
    expect(await openWorkItems(s, sid)).toEqual([]);
  });

  it("openWorkItems handles absent work directory → []", async () => {
    const s = makeStorage();
    expect(await openWorkItems(s, "no-such-session")).toEqual([]);
  });

  it("workExecutionId is deterministic (64-hex) and not persisted", async () => {
    const s = makeStorage();
    const w1 = await openWork(s, sid, "key-a", { n: 1 }, 0);
    const e1 = workExecutionId(w1);
    const e2 = workExecutionId(w1);
    expect(e1).toBe(e2);
    expect(e1).toMatch(/^[0-9a-f]{64}$/);
    // Calling it creates no file and does not alter open items.
    expect(await s.exists(`sessions/${sid}/work/${e1}.open.json`)).toBe(false);
    expect(await openWorkItems(s, sid)).toEqual([w1]);
  });
}

describe("WorkLedger (InMemoryStorage)", () => {
  runWorkLedgerContract(() => new InMemoryStorage());
});

describe("WorkLedger (FileStorage) — same-semantics", () => {
  runWorkLedgerContract(makeFileStorage);
});
