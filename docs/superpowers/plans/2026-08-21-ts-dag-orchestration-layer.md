# DAG 编排层(子项目 3)实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建 `@graph-agent/orchestrator` —— DAG 编排层:提议信任边界 + super-step 归并 + Controller 唯一写入者 + Token 账本 + Controller 事件链 + snapshot-replay checkpoint,每个节点可挂 Session。移植 Python `GraphController` 的语义(非字节格式)。

**Architecture:** 新包 `packages/orchestrator/`,依赖 `@graph-agent/core` + `@graph-agent/session`。Controller 是 MutableRunState 唯一写入者;runner 结果全部不可信,经完整 `validateResult` 才物化;fail-closed 整体拒绝。hash 用 TS-core `canonicalJson`/`sha256`;确定性 ID 用 `deriveControllerId(kind,...parts)`(=core/session `deriveId`,64-hex)。并发:全局 async mutex + per-run single-flight 锁 + max_concurrency 限流;执行阶段不持锁;按 controller 分配的 sequence 归并(完成顺序无关)。

**Spec:** `docs/superpowers/specs/2026-08-21-ts-dag-orchestration-layer-design.md`

## Global Constraints

- **命名** camelCase。**不可变**:记录工厂返回 `Object.freeze`,interface 字段 `readonly`;永不原地改记录,用新对象拷贝(mirror Python frozen dataclass + replace)。
- **枚举值即 wire 格式**(与 Python 一致):RunStatus running/succeeded/failed/cancelled;NodeState ready/blocked/running/succeeded/failed/cancelled;ExecutionState queued/running/succeeded/failed/cancelled;DecisionState accepted/rejected;EdgeType spawn/depends_on/message/skip_context。**node 结果状态 completed → controller 节点状态 succeeded 的映射 load-bearing**。
- **确定性**:无 `Date.now()`/`Math.random()` 直接调用;时间经注入 clock;ID 经 `deriveControllerId`。
- **hash**:TS-core `sha256(canonicalJson(...))` 单一来源;Controller 事件 hash 预像 = `{detail,previousHash,runId,schemaVersion,sequence,type}`;复用 core `resultBindingHash`/`verifyEventChain`/`GENESIS_HASH`。**不逐字节复刻 Python;不承诺跨语言 replay。**
- **fail-closed 信任边界**:任何 validateResult 错误码 → 整体拒绝(无部分采纳),commit 整笔预留,节点 FAILED,processedResults[exec]=[](幂等)。proposals 仅在 status===completed 且结果完全合法时,按 spawn→message→skip 顺序处理。
- **预算规则**:worst-case 预留;good path(completed 且不超预留)commit actual + 释放未用;所有 adverse path(failed/非法/超预算/异常)commit 整笔;取消/阻塞释放预留(不 commit)。全局预算门 = maxTotalTokens - committed - reserved。
- **类型严格**:token 必须整数(拒 bool);unit ∈ [0,1](budgetShare ∈ (0,1]);sha256hex = 64 lowercase hex。用 core 守卫。
- **并发**:全局 mutex + per-run single-flight;执行不持锁;归并按 sequence。Controller 唯一写入者。工厂 `create` 同步(临界区调用)。
- **replay 纯净**:replay/replayCheckpoint 不调用 agent/model/tool/factory;仅从 snapshot 重建 + 再校验。
- **不做**(YAGNI):适配层/HTTP/web(子项目4);分布式/SQLite/运行中 resume/人工审批/auto-retry/all-any fan-in/quorum;ProjectTask;不改 Python `src/`。
- **测试/构建**:`npx vitest run packages/orchestrator/...`;`npm run -w @graph-agent/orchestrator build`。
- **提交**:每 task 末尾 commit,前缀 feat/test/chore。

---

## 文件结构

`packages/orchestrator/`(全部新建):package.json(deps core+session)、tsconfig.json、src/{policy,graph-models,ids,validation,budget,result-binding,controller-events,mutable-state,scheduler,mutations,snapshot-validation,controller,runner,index}.ts、test/*。

---

## Task 1: 包骨架 + policy + ids + graph-models

**Files:** Create `packages/orchestrator/package.json`, `tsconfig.json`, `src/ids.ts`, `src/policy.ts`, `src/graph-models.ts`, `src/index.ts`, tests `test/policy.test.ts`, `test/ids.test.ts`, `test/graph-models.test.ts`.

**Interfaces:**
- package.json: `@graph-agent/orchestrator`, type module, deps `{ "@graph-agent/core": "*", "@graph-agent/session": "*" }`, build/typecheck scripts (mirror packages/session/package.json).
- tsconfig extends `../../tsconfig.base.json`, rootDir src / outDir dist.
- `deriveControllerId(kind: string, ...parts: (string|number)[]): string` = `deriveId(kind, ...parts)` from `@graph-agent/session` (re-uses core hashing). 64-hex, kind-prefixed via being first part.
- `ControllerPolicy` interface (all readonly) + `createControllerPolicy(overrides?)` applying the exact defaults (maxNodes=64, maxEdges=256, maxGeneration=4, maxChildrenPerNode=8, maxTotalTokens=64000, maxConcurrency=4, minTrustScore=0, maxProposalsPerResult=32, maxEventsPerResult=512, maxTextLength=16000, maxIdLength=256, maxMessageTtlSeconds=86400); integer fields validated positive-int (core assertBoundedInt {min:1}), minTrustScore unit-interval. Frozen.
- Enums as frozen const objects + types: RunStatus, NodeState, ExecutionState, DecisionState, EdgeType (exact string values above).
- Record factories (frozen): `createNodeRecord`, `createEdgeRecord` (priority/weight default 0.5, ttlSeconds/contentHash default null), `createExecutionRecord` (committedTokens default 0, eventChainHead default null), `createProposalDecision` (materializedId default null), `createBudgetSnapshot` (+ `availableTokens(snapshot)` helper = limit-committed-reserved).
- `RunSnapshot` interface + `runSnapshotToDict(s)` / `runSnapshotFromDict(d)` round-trippable via canonicalJson (enum values as strings, arrays copied).

- [ ] **Step 1-2:** Write package.json + tsconfig.json.
- [ ] **Step 3:** Write failing tests: policy defaults + validation rejects non-positive/ non-unit; ids deterministic 64-hex + order-sensitive + kind changes id; graph-models factories freeze + defaults + snapshot toDict/fromDict round-trip (deep-equal).
- [ ] **Step 4:** Run → FAIL.
- [ ] **Step 5:** Implement ids.ts, policy.ts, graph-models.ts.
- [ ] **Step 6:** Run → PASS. Write index.ts exporting all of the above (types + values).
- [ ] **Step 7:** `npm run -w @graph-agent/orchestrator build` tsc clean. Commit `chore: scaffold @graph-agent/orchestrator with policy, ids, graph models`.

---

## Task 2: 校验守卫 + result-binding

**Files:** Create `src/validation.ts` (guards portion), `src/result-binding.ts`, `test/validation-guards.test.ts`, `test/result-binding.test.ts`. Modify index.ts.

**Interfaces:**
- In validation.ts, port the low-level guards used by result/proposal validation (return-or-throw style, reused by later tasks): `validateText(value, limit)` (string, non-empty after trim, len≤limit), `validateUnit(value, {positive?})` (reject bool; number; finite; 0≤n≤1; positive→n≠0), `normalizeTools(names, maxLen)` (reject string as the iterable; each non-empty string ≤maxLen; unique), `isSha256Hex(value)` (string len 64 all 0-9a-f). Export them.
- result-binding.ts: REUSE core `resultBindingHash` directly (core already exports it); add `terminalResultHash(result)` helper returning `result.events[result.events.length-1].metadata.result_hash` (or null) and `verifyResultBinding(result): boolean` recomputing core resultBindingHash over (nodeId,status,output,inputTokens,outputTokens,spawn,message,skip,error) and comparing to the terminal event's metadata result_hash.

- [ ] **Step 1:** Failing tests: validateText/validateUnit/normalizeTools/isSha256Hex each accept valid + reject each invalid (bool rejected by validateUnit; duplicate tools rejected; 63/65-char hex rejected). result-binding: a well-formed result verifies true; tamper output/usage/proposals → false.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Reuse core resultBindingHash (check its exact signature in packages/core/src/events.ts) + core guards where they already exist (assertNonEmptyText etc.) — only add what core lacks.
- [ ] **Step 4:** Run → PASS. Update index. Commit `feat: add validation guards and result-binding verification`.

---

## Task 3: 预算账本(纯函数)

**Files:** Create `src/budget.ts`, `test/budget.test.ts`. Modify index.ts.

**Interfaces:** A `BudgetLedger` operating on `{ committedTokens, reservedTokens, limitTokens }` + `nodeReservations: Map<string,number>`, expressed as PURE functions returning new ledger state (no mutation):
- `reserve(ledger, nodeId, amount)` → adds reservation (amount≥1), reservedTokens+=amount; throws if amount>available.
- `available(ledger)` = limit - committed - reserved.
- `claimReservation(ledger, nodeId)` → pops nodeId's reservation (returns amount; reservedTokens unchanged per spec — reservation stays reserved during execution; caller stores it in the ExecutionRecord).
- `commitSuccess(ledger, reserved, actualTokens)` → reservedTokens-=reserved; committed+= (actual>reserved ? reserved : min(max(actual,0),reserved)); returns {ledger, overBudget: actual>reserved, committed}.
- `commitFull(ledger, reserved)` → reservedTokens-=reserved; committed+=reserved (failed/invalid/exception path).
- `release(ledger, amount)` → reservedTokens-=amount; committed unchanged (cancel/blocked path).
- `budgetSnapshot(ledger)` → BudgetSnapshot.
- Invariants asserted where written: committed≥0, reserved≥0, committed+reserved≤limit; per-exec reserved≥1, 0≤committed≤reserved.

- [ ] **Step 1:** Failing tests covering EACH path: reserve within/over available; claim; commitSuccess under-reserve (release unused) / exactly / over (overBudget true, full commit); commitFull; release; invariants hold after each; a spawn-budget-gate scenario.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement pure functions.
- [ ] **Step 4:** Run → PASS. Update index. Commit `feat: add single-writer budget ledger`.

---

## Task 4: Controller 事件链

**Files:** Create `src/controller-events.ts`, `test/controller-events.test.ts`. Modify index.ts.

**Interfaces:** Mirror core events.ts single-hashableFields pattern.
- `CONTROLLER_GENESIS_HASH = "0".repeat(64)`.
- `ControllerEvent` readonly `{ sequence, runId, type, detailJson, previousHash, eventHash, schemaVersion }`.
- `ControllerEventType` union: "run_created"|"snapshot"|"dependency_added"|"execution_settled".
- `createControllerEvent(sequence, runId, type, detail: object, previousHash)` → detailJson=canonicalJson(detail); eventHash=sha256(canonicalJson({detail,previousHash,runId,schemaVersion:1,sequence,type})) — SINGLE hashable-fields helper used by both create and verify (sub-project-1 lesson). Frozen.
- append helper maintaining sequence (=len), previousHash (last eventHash or genesis).
- `verifyControllerEventChain(events): boolean` — each i: schemaVersion===1, runId constant, sequence===i, previousHash linkage, eventHash recompute, detailJson strict-parses (reject NaN/Infinity/dup keys — use a strict parse helper); empty → false.
- `controllerEventDetail(event): object` strict-parse of detailJson.

- [ ] **Step 1:** Failing tests: append two events from genesis (sequence/previousHash chain); verify true; tamper detailJson/eventHash/sequence → false; empty → false; the 4 event types build. Strict parse rejects dup keys/NaN.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement with single hashableFields helper. (canonicalJson already rejects NaN/Infinity — confirm; for dup-key rejection on parse, implement a strict JSON.parse reviver or reuse a helper.)
- [ ] **Step 4:** Run → PASS. Update index. Commit `feat: add controller event chain`.

---

## Task 5: validateResult 信任边界(完整 12 条清单)

**Files:** Modify `src/validation.ts` (add validateResult + proposal validators), Create `test/validate-result.test.ts`. Modify index.ts.

**Interfaces:**
- `validateResult(result, expectedNodeId, policy): string | null` — returns an error CODE string or null. Implements the exhaustive 12-check list from the spec §五 (SOURCE_MISMATCH, INVALID_EVENT_CHAIN, INVALID_EVENT_STATE, INVALID_NODE_STATUS, INVALID_EVENT_SCHEMA, INVALID_USAGE, MALFORMED_RESULT, PROPOSAL_LIMIT, RESULT_BINDING_MISMATCH). Any thrown error inside → "MALFORMED_RESULT". Reuse core verifyEventChain, EventType, NodeStatus, resultBindingHash; reuse Task 2 guards + isSha256Hex.
- `validateSpawn(proposal, parent, state, policy): {code,message}|null` — the 11 spawn checks (types, parentNodeId, generation===parent.gen+1 int ≤maxGeneration, node/edge/child limits, field validation, tool subset, budget-share sum ≤1).
- `validateMessage(proposal, source, state, policy)` / `validateSkip(proposal, requester, state, policy)` — per spec (target exists, self-edge, ancestor walk for skip).
- `isAncestor(state, ancestorId, descendantId)` walking parentNodeId chain.

Note: `state` here is a read-only view of MutableRunState (nodes map, edges list) — define a minimal readonly interface these validators consume (they do NOT mutate; mutation is Task 7).

- [ ] **Step 1:** Failing tests: a fully valid COMPLETED result → null; construct a result via core factories + a real node EventRecorder chain (import from core: EventRecorder, createAgentResult, createUsage, createNodeError, proposals) so events + result_hash are genuine; then a test PER error code that mutates one aspect to trigger exactly that code. validateSpawn/Message/Skip: valid → null; each rejection path → its code.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. This is the correctness core — follow the spec's numbered list exactly; exact type checks (integer tokens reject bool via a helper; timestamp finite number; metadata is object).
- [ ] **Step 4:** Run → PASS. Update index. Commit `feat: add result trust-boundary validation (validateResult + proposal validators)`.

---

## Task 6: mutable-state + snapshot-validation

**Files:** Create `src/mutable-state.ts`, `src/snapshot-validation.ts`, `test/snapshot-validation.test.ts`. Modify index.ts.

**Interfaces:**
- `MutableRunState` (the ONE mutable object the controller owns): runId, status, policy, nodes: Map<string,NodeRecord>, specs/runners/inputs maps, edges: EdgeRecord[], executions: Map<string,ExecutionRecord>, decisions: ProposalDecision[], processedResults: Map<string,readonly ProposalDecision[]>, nodeReservations: Map<string,number>, committedTokens, reservedTokens, enqueueSequence, superstep. Plus `snapshotOf(state): RunSnapshot` producing a frozen snapshot (pendingExecutions = count nodes in READY|RUNNING).
- `validateSnapshot(snapshot, expectedRunId): string | null` — the replay re-validation from spec §八: runId match/non-empty; unique+truthy node/edge/execution ids; edge endpoints ∈ nodes; exec.nodeId ∈ nodes; budget invariants; pendingExecutions===count(READY|RUNNING); superstep int≥0; per-exec budget; status/pending consistency (SUCCEEDED→all nodes SUCCEEDED; non-RUNNING→pending===0). schema error → a code string.

- [ ] **Step 1:** Failing tests: snapshotOf reflects state (pending count); validateSnapshot passes a well-formed snapshot; each invariant violation (dup id, dangling edge, budget over limit, pending mismatch, non-RUNNING w/ pending) → rejected.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS. Update index. Commit `feat: add mutable run state and snapshot validation`.

---

## Task 7: mutations(applySpawn/Message/Skip)+ runner 接口

**Files:** Create `src/mutations.ts`, `src/runner.ts`, `test/mutations.test.ts`. Modify index.ts.

**Interfaces:**
- runner.ts: `interface NodeRunner { readonly spec: AgentSpec; run(input: AgentInput, signal?: AbortSignal): Promise<AgentResult> }`; `interface NodeFactory { create(args: { spec: AgentSpec; toolNames: readonly string[] }): NodeRunner }` (create is SYNC); `class RunnerCancelledError extends Error` sentinel. (AgentSpec: check if core exports one; if core lacks AgentSpec, define a minimal `AgentSpec { identity: AgentIdentity; budget: NodeBudget; role?: string }` in runner.ts and note the deviation in the report.)
- mutations.ts: `applySpawn(state, parent, proposal, ordinal, factory, runId): ProposalDecision` — runs validateSpawn; on pass: childId=deriveControllerId("node",runId,parent.nodeId,ordinal,proposal.proposalId) (duplicate→DUPLICATE_PROPOSAL); allocation=max(1,floor(parent.allocationTokens*budgetShare)); global gate (>available→TOKEN_BUDGET_EXHAUSTED); factory.create in try/catch (→FACTORY_ERROR); materialize READY node + spec + runner + input (SPAWN ContextPacket, trust=min(parent.trust,1)) + reservation (reserve ledger) + SPAWN edge; returns ACCEPTED decision with materializedId=childId. On any check fail: REJECTED decision with code. All state changes via new records (no in-place mutation of existing records).
- `applyMessage(state, source, proposal, runId): ProposalDecision`; `applySkip(state, requester, proposal, runId): ProposalDecision` — per spec, materialize context edges; REJECTED decision on fail.

- [ ] **Step 1:** Failing tests (build a MutableRunState with a root node + a stub NodeFactory): applySpawn materializes child (READY, gen+1, reservation, SPAWN edge) + ACCEPTED decision; duplicate proposalId → DUPLICATE_PROPOSAL rejected; over-budget → TOKEN_BUDGET_EXHAUSTED; factory throw → FACTORY_ERROR; applyMessage creates MESSAGE edge / rejects unknown target / self-edge; applySkip creates SKIP_CONTEXT edge / rejects non-ancestor.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS. Update index. Commit `feat: add graph mutations and runner interface`.

---

## Task 8: scheduler(super-step 归并)+ ingest

**Files:** Create `src/scheduler.ts`, `test/scheduler.test.ts`. Modify index.ts.

**Interfaces:** A small async mutex (per-run single-flight) + a bounded-concurrency runner helper (implement inline; no external dep). Core functions operating on MutableRunState under the controller's lock discipline:
- `freezeFrontierAndClaim(state): Claim[]` (caller holds global lock): frontier = READY nodes with all depends_on sources SUCCEEDED, sorted (-priority, nodeId); per node pop reservation (<1→node FAILED, skip); executionId=deriveControllerId("exec",runId,nodeId,enqueueSequence); RUNNING ExecutionRecord (reserved=reservation); enqueueSequence++; node→RUNNING; collect claim {node, execution, runner, input}. superstep++.
- `ingestLocked(state, execution, node, result): readonly ProposalDecision[]` — the spec §五 ingest flow: idempotent (processedResults hit → return prior); validateResult → error code → fail-closed (commitFull, node/exec FAILED, processedResults[exec]=[], execution_settled event); usage overrun → USAGE_EXCEEDS_RESERVATION; else commitSuccess/commitFull per status; if completed process proposals spawn→message→skip via Task 7, append decisions; store processedResults.
- `settleException(state, execution, node, error)` — commitFull, node/exec FAILED, code=error name.
- `blockFailedDependents(state)` fixpoint; `settleRun(state)` status precedence (RUNNING if any READY/RUNNING > CANCELLED if any cancelled > FAILED if any FAILED/BLOCKED > SUCCEEDED); `cancelClaims(state, claims)`.
- These are the building blocks; the actual lock-holding orchestration lives in Task 9's controller.

- [ ] **Step 1:** Failing tests: freezeFrontierAndClaim sorts by (-priority,nodeId) + claims + assigns sequences; ingestLocked idempotency + fail-closed + proposal-order spawn-before-message-before-skip; settleException; blockFailedDependents fixpoint; settleRun precedence.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS. Update index. Commit `feat: add super-step scheduler and result ingestion`.

---

## Task 9: GraphController 门面 + checkpoint/replay + 端到端 + 全量验证

**Files:** Create `src/controller.ts`, `test/controller.test.ts`, `test/checkpoint-replay.test.ts`, `test/e2e.integration.test.ts`. Modify index.ts.

**Interfaces:** `class GraphController` over a NodeFactory + policy + injected clock:
- `createRun(runId, rootSpec, rootRunner, rootInput): RunSnapshot` (global lock): materialize root node (READY), reserve min(rootSpec.budget.maxTotalTokens, policy.maxTotalTokens); append run_created + snapshot events; return snapshot.
- `runSuperstep(runId): Promise<RunSnapshot>` — per-run single-flight lock for the WHOLE op; inside: acquire global lock → freezeFrontierAndClaim → release; run claims concurrently (max_concurrency; AbortSignal for cancel; catch node self-cancel → RunnerCancelledError as exception result; other throws captured); re-acquire global lock → sort raw by execution.sequence → per result: exception→settleException else ingestLocked → settleRun → snapshot event → return snapshot.
- `runUntilIdle(runId): Promise<RunSnapshot>` loop until pendingExecutions===0.
- `addDependency(runId, sourceNodeId, targetNodeId): RunSnapshot` (both locks): only to a READY target; DAG-preserving over spawn+depends_on edges (reject cycle); append dependency_added + snapshot events.
- `cancel(runId): RunSnapshot` — cancelClaims/release READY reservations, status CANCELLED, snapshot event.
- `checkpoint(runId): string` — canonicalJson({chainHead,eventCount,events,runId,schemaVersion:1,stateDigest}).
- `static replayCheckpoint(json): RunSnapshot` and `static replay(events): RunSnapshot` — per spec §八; **must not call factory/runner** (test asserts a throwing factory is never invoked).

- [ ] **Step 1:** Failing `test/controller.test.ts`: createRun → root READY + budget reserved + events; addDependency gates a node; cancel releases.
- [ ] **Step 2:** Run → FAIL. Implement controller.ts. Run → PASS.
- [ ] **Step 3:** Failing `test/checkpoint-replay.test.ts`: checkpoint→replayCheckpoint round-trip yields an equal final snapshot; tamper stateDigest/chain/key-set → rejected; **replay with a factory that throws if create() is called → replay succeeds (factory never called)**. Run → FAIL → implement → PASS.
- [ ] **Step 4:** Failing `test/e2e.integration.test.ts`: a stub NodeFactory whose root runner emits a spawn proposal (build a genuine AgentResult with real event chain + result_hash via core), child runners complete; runUntilIdle converges (root SUCCEEDED, child SUCCEEDED, budget consistent). **Merge determinism**: two children complete out of sequence order (delay one runner) → final snapshot identical regardless. fail-closed: a runner returns an invalid result → node FAILED, full reservation committed, no child materialized. Cancel mid-run releases reservations. Run → FAIL → implement any glue → PASS.
- [ ] **Step 5: 全量验证** — `npx vitest run` (repo root): core + session + orchestrator all green (report total). `npm run -ws --if-present build` tsc clean across workspaces. `@graph-agent/orchestrator` imports core + session. Python untouched (`PYTHONPATH=src .venv/bin/python -c "import graph_agent.controller; print('py-ok')"` or skip w/ note).
- [ ] **Step 6: Commit** `feat: add GraphController facade with checkpoint/replay; wire @graph-agent/orchestrator public API`.

---

## 成功标准

1. `@graph-agent/orchestrator` 依赖 core+session,tsc 严格构建通过。
2. `npm test` 全绿:12 条信任边界清单、预算所有路径、归并确定性、controller 事件链篡改检出、checkpoint/replay 幂等 + 篡改拒绝 + replay 不触发 factory、端到端多代 spawn 收敛。
3. fail-closed 与取消/阻塞的预算释放正确。
4. 提供节点↔Session 绑定接口(runner 可用 Session);可选 SessionBackedRunner(若时间允许,否则接口足够)。
5. Python `src/` 不受影响。

## Self-Review 记录

- **Spec 覆盖**:§三→T1;§五守卫+binding→T2;§六→T3;§七→T4;§五 validateResult+proposal validators→T5;mutable-state+§八 validateSnapshot→T6;applySpawn/Message/Skip+runner→T7;§四 scheduler+ingest→T8;§八 controller+checkpoint/replay+§九绑定+§十一端到端→T9。
- **占位扫描**:无 TBD。含 IO/状态机的 task 给接口契约 + 复用点(core/session),执行者按 spec+接口+测试三方约束补全(与子项目1/2 同粒度)。
- **类型一致性**:枚举值跨 task 一致;deriveControllerId 复用 session deriveId;resultBindingHash/verifyEventChain/EventRecorder 复用 core;MutableRunState 单一可变态,记录不可变拷贝;NodeStatus(completed)↔NodeState(succeeded)映射标注 load-bearing。
- **已知取舍**:AgentSpec 若 core 无则在 runner.ts 定义最小版(记 ledger);SessionBackedRunner 为可选便利封装,接口是硬要求;merge 确定性测试在 T8(ingest 顺序)+ T9(端到端乱序完成)双重覆盖。
