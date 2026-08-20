# Session 运行时层(子项目 2)实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建 `@graph-agent/session` —— 管理单个 Agent 状态与历史的 Session 运行时层:文件存储原语 + SessionDoc + hash-chained 消息历史 + 一 active run 的 Runtime + 多 open work 的 WorkLedger + 幂等 Inbox + 崩溃恢复。

**Architecture:** 新包 `packages/session/`,依赖 `@graph-agent/core`。所有 IO 收敛到 `Storage` 接口(`FileStorage` 真实磁盘 + `InMemoryStorage` 测试,同语义)。崩溃安全靠 atomic replace(temp+rename+fsync)+ create-once + append-only 日志 + 幂等重放,不建事务数据库。复用 core 的 canonicalJson/sha256/事件链/守卫。所有模型 readonly + Object.freeze。注入 clock 保证确定性。

**Tech Stack:** Node.js、TypeScript(strict)、tsc、vitest。运行时依赖仅 `@graph-agent/core` + Node 内建 `fs`/`crypto`。

**Spec:** `docs/superpowers/specs/2026-08-21-ts-session-runtime-layer-design.md`

## Global Constraints

- **命名**:camelCase。**不可变**:模型工厂返回 `Object.freeze`,interface 字段 `readonly`。
- **崩溃安全**:多字节写一律 `atomicWrite`(temp→fsync→rename);去重写用 `createOnce`(`wx`);历史用 append-only。跨文件不做事务。
- **确定性**:无 `Date.now()`/`Math.random()` 直接调用——时间经注入的 `clock: () => number`,ID 经 `sha256` 派生(承接 core `EventRecorder(nodeId, clock?)` 模式)。
- **hash 链**:消息历史 entryHash = `sha256(canonicalJson(entry 除 entryHash 外字段))`,genesis 复用 core `GENESIS_HASH`。
- **fail-closed**:非法状态转移 / 篡改的 hash 链 / 非法输入抛错(复用 core 守卫);IO 错误显式传播,不静默吞。
- **Storage 双实现同语义**:`InMemoryStorage` 与 `FileStorage` 必须通过同一套契约测试。
- **不做**(YAGNI):DAG 编排(子项目3)、适配器/HTTP/web(子项目4)、ProjectTask、事务数据库、物理 exactly-once;不改 Python `src/`。
- **测试/构建**:`npm test`(根)或 `npx vitest run <file>`;`npm run -w @graph-agent/session build`。
- **提交**:每 task 末尾 commit,前缀 feat/test/chore。

---

## 文件结构

`packages/session/`(全部新建):
- `package.json` — `@graph-agent/session`,`dependencies: { "@graph-agent/core": "*" }`(workspace),build 脚本 tsc。
- `tsconfig.json` — extends `../../tsconfig.base.json`。
- `src/storage.ts` — `Storage` 接口 + `InMemoryStorage` + `FileStorage` + 崩溃点注入(测试用)。
- `src/ids.ts` — `deriveId(...parts)` 确定性 ID(sha256 派生)。
- `src/session-doc.ts` — `SessionDoc` 模型 + `writeSessionDoc`/`readSessionDoc`。
- `src/message-store.ts` — `StoredMessage`、`appendMessage`、`readMessages`、`verifyMessageChain`。
- `src/runtime.ts` — `RuntimeState`、`startRun`/`finishRun`、active-run 不变量。
- `src/work-ledger.ts` — `openWork`/`settleWork`/`openWorkItems`,幂等。
- `src/inbox.ts` — `putIfAbsent`/`ackAfterHistory`/`deliveryStatus`。
- `src/recovery.ts` — `recoverSession`。
- `src/session.ts` — `Session` 门面聚合以上。
- `src/index.ts` — 统一导出。
- `test/*.test.ts` — 每模块一份 + `storage-contract`(双实现同跑)+ `recovery.integration.test.ts`。

---

## Task 1: 包骨架 + Storage 契约(InMemory 先行)

**Files:** Create `packages/session/package.json`, `packages/session/tsconfig.json`, `src/storage.ts`, `src/index.ts`, `test/storage-contract.test.ts`.

**Interfaces:**
- Produces: `Storage` 接口 `{ atomicWrite(path,bytes), createOnce(path,bytes), appendLine(path,line), read(path), readLines(path), exists(path), list(dir), withLock(path, fn) }`(全 async,`bytes`/`read` 用 `string` UTF-8);`InMemoryStorage` 实现,构造可选注入 `{ clock?: ()=>number, crashAfter?: number }`(写计数达到 crashAfter 抛 `CrashInjected`,用于恢复测试)。`createOnce` 已存在抛 `FileExistsError`。`withLock` 用 createOnce 锁文件,持锁执行 fn,finally 释放;陈旧锁按注入 clock 时间戳接管。

- [ ] **Step 1: 写 `package.json`**
```json
{
  "name": "@graph-agent/session",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": { "build": "tsc -p tsconfig.json", "typecheck": "tsc -p tsconfig.json --noEmit" },
  "dependencies": { "@graph-agent/core": "*" }
}
```

- [ ] **Step 2: 写 `tsconfig.json`**
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "rootDir": "src", "outDir": "dist" },
  "include": ["src"]
}
```

- [ ] **Step 3: 写失败测试 `test/storage-contract.test.ts`** — 导出 `runStorageContract(makeStorage)`,断言:atomicWrite 后 read 得原值;createOnce 二次抛错;appendLine+readLines 顺序;withLock 串行化并发写(共享计数器验互斥);crashAfter 注入时 atomicWrite 不留半截(read 得旧值或完整新值)。底部 `describe("InMemoryStorage", ...)`。
```ts
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
```

- [ ] **Step 4: Run `npx vitest run packages/session/test/storage-contract.test.ts`** → FAIL (storage.js missing).

- [ ] **Step 5: 写 `src/storage.ts`** — `Storage` 接口如上;`InMemoryStorage` 用 `Map<string,string>` 存整文件 + append 日志(append 用 `\n` 连接),`clock` 默认 `() => 0`,写操作计数达 `crashAfter` 抛 `class CrashInjected extends Error`;`createOnce` 命中已存在抛 `class FileExistsError extends Error`;`withLock` 用内部 promise 队列串行化(内存 async 互斥)。`atomicWrite` 语义:若崩溃点在"提交"前触发则抛错、旧值保留(先算完整新值,最后一步才替换)。导出全部符号。

- [ ] **Step 6: Run same test** → PASS. 写 `src/index.ts` re-export `Storage`(type)、`InMemoryStorage`、`CrashInjected`、`FileExistsError`(FileStorage 于 Task 2 补加)。

- [ ] **Step 7: Commit** `chore: scaffold @graph-agent/session with Storage contract + InMemoryStorage`.

---

## Task 2: FileStorage(真实磁盘,同契约)

**Files:** Modify `src/storage.ts` (add `FileStorage`), `src/index.ts`; Create `test/storage-file.test.ts`.

**Interfaces:** Consumes `runStorageContract` from Task 1's test file. Produces `FileStorage` constructed with `{ rootDir: string, clock?: ()=>number, crashAfter?: number }`; same `Storage` semantics on real fs (`node:fs/promises`): `atomicWrite` = write `${path}.tmp.${n}` → fh `fsync`/`sync` → `rename`; `createOnce` = `open(path,"wx")`; `appendLine` = `appendFile(path, line+"\n")`; `withLock` = createOnce a `${path}.lock`, stale-takeover by mtime vs injected clock; paths resolved under `rootDir`.

- [ ] **Step 1: 写失败测试 `test/storage-file.test.ts`**
```ts
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
```
- [ ] **Step 2: Run** → FAIL (FileStorage missing).
- [ ] **Step 3: 实现 `FileStorage`** in `src/storage.ts` per Interfaces; crash injection throws before rename (same write-count model as InMemory). Update `src/index.ts` to export `FileStorage`.
- [ ] **Step 4: Run `npx vitest run packages/session/test/storage-file.test.ts`** → PASS (同契约在磁盘上也绿).
- [ ] **Step 5: `npm run -w @graph-agent/session build`** → tsc clean.
- [ ] **Step 6: Commit** `feat: add FileStorage passing the shared storage contract`.

---

## Task 3: 确定性 ID + SessionDoc

**Files:** Create `src/ids.ts`, `src/session-doc.ts`, `test/ids.test.ts`, `test/session-doc.test.ts`. Modify `src/index.ts`.

**Interfaces:** Produces `deriveId(...parts: (string|number)[]): string` = `sha256(canonicalJson(parts))` (from core). `SessionDoc` readonly `{ sessionId, agentIdentity: AgentIdentity, createdAt: number, schemaVersion: number, metadata: Readonly<Record<string,unknown>> }` + `createSessionDoc(input)` (frozen, guards-validated, schemaVersion=1). `writeSessionDoc(storage, sessionId, doc)` → atomicWrite `sessions/${sessionId}/session.json`; `readSessionDoc(storage, sessionId)` → SessionDoc.

- [ ] **Step 1: 写失败测试 `test/ids.test.ts`** — `deriveId("a",1)` 稳定、64-hex;不同参数→不同 id;参数顺序敏感.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: 写 `src/ids.ts`** using `canonicalJson`+`sha256` from `@graph-agent/core`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: 写失败测试 `test/session-doc.test.ts`** — create defaults+frozen; round-trip via InMemoryStorage; reject empty sessionId.
- [ ] **Step 6: Run** → FAIL.
- [ ] **Step 7: 写 `src/session-doc.ts`** — reuse core `createAgentIdentity`/guards; path `sessions/${sessionId}/session.json`.
- [ ] **Step 8: Run** → PASS. Update `src/index.ts`.
- [ ] **Step 9: Commit** `feat: add deterministic ids and SessionDoc`.

---

## Task 4: MessageStore(hash-chained append-only)

**Files:** Create `src/message-store.ts`, `test/message-store.test.ts`. Modify `src/index.ts`.

**Interfaces:** Produces `StoredMessage` readonly `{ sequence, role, content, toolCallsJson, previousHash, entryHash }` (role/content mirror core Message; toolCalls serialized to canonical JSON string). `appendMessage(storage, sessionId, msg)` → append one JSON line to `sessions/${sessionId}/messages.log`, chaining `previousHash` from last entry (or core `GENESIS_HASH`), `entryHash = sha256(canonicalJson(fields except entryHash))`; returns StoredMessage. `readMessages(storage, sessionId)` → `readonly StoredMessage[]`. `verifyMessageChain(messages)` → boolean (sequence===index, previousHash linkage, entryHash recompute — same shape as core `verifyEventChain`).

- [ ] **Step 1: 写失败测试** — append two chains from GENESIS; readMessages round-trips; verifyMessageChain true; tamper content→false; broken link→false; empty→true.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: 实现** — extract a private `hashableFields(entry)` used by BOTH append and verify (single field-set definition — learned from sub-project-1 event-chain review). Reuse core canonicalJson/sha256/GENESIS_HASH.
- [ ] **Step 4: Run** → PASS. Update index.
- [ ] **Step 5: Commit** `feat: add hash-chained MessageStore`.

---

## Task 5: Runtime(至多一个 active run)

**Files:** Create `src/runtime.ts`, `test/runtime.test.ts`. Modify `src/index.ts`.

**Interfaces:** Produces `RuntimeState` readonly `{ status: "idle"|"running", activeRunId: string|null, updatedAt: number }`. `startRun(storage, sessionId, agentInput, seq, clock)` → runId (`deriveId(sessionId,"run",seq)`); reads runtime file `sessions/${sessionId}/runtime.json`, if `running` throws `IllegalRuntimeTransition`, else atomicWrite `running`+activeRunId. `finishRun(storage, sessionId, runId, agentResult, clock)` → createOnce archived result projection `sessions/${sessionId}/runs/${runId}.json` then atomicWrite runtime `idle`; double finish idempotent short-circuit. `readRuntime(storage, sessionId)` → RuntimeState (defaults idle if absent).

- [ ] **Step 1: 写失败测试** — fresh idle; startRun→running w/ runId; second startRun while running throws `IllegalRuntimeTransition`; finishRun→idle + archived result readable; double finishRun no double archive.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: 实现** — reuse core `AgentInput`/`AgentResult`/`NodeStatus`; guards; frozen states.
- [ ] **Step 4: Run** → PASS. Update index.
- [ ] **Step 5: Commit** `feat: add single-active-run Runtime state machine`.

---

## Task 6: WorkLedger(多 open work,幂等 settle)

**Files:** Create `src/work-ledger.ts`, `test/work-ledger.test.ts`. Modify `src/index.ts`.

**Interfaces:** Produces `openWork(storage, sessionId, correlationKey, payload, seq)` → workId (`deriveId(sessionId, correlationKey, seq)`); createOnce `sessions/${sessionId}/work/${workId}.open.json`; same correlationKey+seq → same workId, idempotent (createOnce hit-existing returns existing workId, no throw to caller). `settleWork(storage, sessionId, workId, result)` → createOnce `work/${workId}.settled.json`; double settle idempotent short-circuit (no overwrite). `openWorkItems(storage, sessionId)` → workIds with `.open` but no `.settled`. `workExecutionId(workId)` = `deriveId(workId,"exec")` (read-only projection; not persisted).

- [ ] **Step 1: 写失败测试** — open two distinct works both listed; same correlationKey+seq → same workId; settle removes from openWorkItems; double settle no-op (one settled file, same content); workExecutionId deterministic.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: 实现** — catch `FileExistsError` from createOnce for put-if-absent idempotency; frozen records.
- [ ] **Step 4: Run** → PASS. Update index.
- [ ] **Step 5: Commit** `feat: add WorkLedger with idempotent open/settle`.

---

## Task 7: Inbox/Outbox(幂等投递,history-before-ACK)

**Files:** Create `src/inbox.ts`, `test/inbox.test.ts`. Modify `src/index.ts`.

**Interfaces:** Produces `putIfAbsent(storage, sessionId, messageId, envelope)` → `"accepted"|"duplicate"` (createOnce `inbox/${messageId}.env.json`; existing → duplicate). `ackAfterHistory(storage, sessionId, messageId, appendToHistory: () => Promise<void>)` → run `appendToHistory` FIRST (history persisted), THEN createOnce `inbox/${messageId}.receipt.json`; if callback throws, propagate and skip receipt. `deliveryStatus(storage, sessionId, messageId)` → `"none"|"pending"|"delivered"`. `pendingDeliveries(storage, sessionId)` → messageIds with env but no receipt.

- [ ] **Step 1: 写失败测试** — putIfAbsent first accepted, second duplicate; ackAfterHistory calls history callback BEFORE writing receipt (assert ordering via recording array); status none→pending→delivered; pendingDeliveries lists env-without-receipt; callback throw → no receipt (status stays pending).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: 实现** — await callback then createOnce receipt; on throw skip receipt.
- [ ] **Step 4: Run** → PASS. Update index.
- [ ] **Step 5: Commit** `feat: add idempotent Inbox/Outbox with history-before-ACK`.

---

## Task 8: 恢复 + Session 门面 + 全量验证

**Files:** Create `src/recovery.ts`, `src/session.ts`, `test/recovery.integration.test.ts`, `test/session.test.ts`. Modify `src/index.ts`.

**Interfaces:** Produces `recoverSession(storage, sessionId)` → `{ messages, runtime, interruptedRunId, openWork, pendingDeliveries }` consistent snapshot: verify+truncate message chain to last intact entry; if runtime `running` but no archived run file → `interruptedRunId`; list open work; list pending deliveries. Idempotent (recover twice === same). `Session` facade class over `(storage, sessionId)`: `Session.open(storage, sessionId, agentIdentity)` (writes SessionDoc), `Session.load(storage, sessionId)`, methods `appendMessage`, `startRun`/`finishRun`, `openWork`/`settleWork`, `deliver` (putIfAbsent + ackAfterHistory), `recover()`. All writes wrapped in `storage.withLock("sessions/${sessionId}/.lock", ...)` for single-writer.

- [ ] **Step 1: 写失败测试 `test/session.test.ts`** — open→load round-trip; appendMessage then readMessages; startRun/finishRun cycle; openWork/settleWork; deliver puts message into history + receipt. Via InMemoryStorage.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: 实现 `src/session.ts`** aggregating Tasks 3-7 + withLock.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: 写失败测试 `test/recovery.integration.test.ts`** — using InMemoryStorage `crashAfter`: crash mid message-append → recover truncates to last intact, chain verifies; crash after startRun before archive → interruptedRunId reported; crash after openWork before settle → work still open; crash after history before receipt → pendingDeliveries lists it; **recover twice yields identical snapshot** (idempotent).
- [ ] **Step 6: Run** → PASS.
- [ ] **Step 7: 全量验证** — `npm test` (core 69 + session suites green); `npm run -w @graph-agent/session build` tsc clean; `@graph-agent/session` imports `@graph-agent/core`; Python untouched (`PYTHONPATH=src .venv/bin/python -c "import graph_agent.models; print('ok')"` 或无 venv 则跳过并说明).
- [ ] **Step 8: Commit** `feat: add crash recovery and Session facade; wire @graph-agent/session public API`.

---

## 成功标准

1. `@graph-agent/session` 依赖 core,`tsc` 严格构建通过。
2. `npm test` 全绿:storage 契约(InMemory+File 双实现)、消息链篡改检测、active-run 不变量、WorkLedger/Inbox 幂等、崩溃恢复幂等收敛。
3. `InMemoryStorage` 与 `FileStorage` 通过同一契约测试。
4. `Session` 门面 API 就绪,供子项目 3 给每个 DAG 节点挂 Session。
5. Python `src/` 不受影响。

## Self-Review 记录

- **Spec 覆盖**:§3.1 Storage→T1/T2;§3.2 SessionDoc→T3;§3.3 MessageStore→T4;§3.4 Runtime→T5;§3.5 WorkLedger→T6;§3.6 Inbox→T7;§四 恢复+门面→T8;§六 测试逐条落 task;§七 YAGNI→Global Constraints「不做」;ProjectTask 延后已明确。
- **占位扫描**:无 TBD。契约测试给出完整代码;实现步给接口契约 + 复用点(含 IO/状态机的实现体逐行贴反而僵化,执行者按 spec+接口+测试三方约束补全——与子项目1同粒度的合理放宽)。
- **类型一致性**:`Storage` 方法签名 T1 定义、T2 同契约复用;`deriveId`/`GENESIS_HASH`/canonicalJson 来自 core;真相源文件路径布局 `sessions/${sessionId}/...` 跨 task 一致;`hashableFields` 单一定义(承接子项目1事件链复审教训);crash 注入模型(`crashAfter` 写计数)InMemory 与 File 一致。
- **已知取舍**:含 IO 与状态机的 task 给接口契约而非逐行实现,比子项目1略粗;若执行时某 task 过大则拆分并在 ledger 记录。
