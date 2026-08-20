import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStorage } from "../src/storage.js";
import { runStorageContract } from "./storage-contract.test.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function makeFileStorage(opts?: object): { s: FileStorage; root: string } {
  const root = mkdtempSync(join(tmpdir(), "ga-session-"));
  dirs.push(root);
  return { s: new FileStorage({ rootDir: root, ...opts }), root };
}

describe("FileStorage", () =>
  runStorageContract((opts) => makeFileStorage(opts as object).s),
);

describe("FileStorage.list excludes internal artifacts", () => {
  it("does not leak the .lock file while a withLock critical section holds it", async () => {
    const { s } = makeFileStorage();
    await s.atomicWrite("d/real.json", "{}");
    // During the critical section d/real.json.lock exists on disk; list must exclude it.
    await s.withLock("d/real.json", async () => {
      expect(await s.list("d")).toEqual(["d/real.json"]);
    });
    // After release the lock is gone and list is still clean.
    expect(await s.list("d")).toEqual(["d/real.json"]);
  });

  it("excludes stray .tmp.<digits> temp files from list", async () => {
    const { s, root } = makeFileStorage();
    await s.atomicWrite("d/a", "committed");
    // Simulate a leftover temp file from a crash that occurred before rename+cleanup.
    writeFileSync(join(root, "d", "a.tmp.7"), "partial");
    expect(await s.list("d")).toEqual(["d/a"]);
  });
});
