import { afterEach, describe } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStorage } from "../src/storage.js";
import { runStorageContract } from "./storage-contract.test.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("FileStorage", () =>
  runStorageContract((opts) => {
    const root = mkdtempSync(join(tmpdir(), "ga-session-"));
    dirs.push(root);
    return new FileStorage({ rootDir: root, ...(opts as object) });
  }),
);
