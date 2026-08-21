# 可恢复 Checkpoint + Session 状态 + 断点续跑(子项目 5)实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`).

**Goal:** 让 checkpoint 保存拓扑 + 每节点 session 状态,支持从断点续跑。新增:core dict 投影、node SessionBackedMemory + spec dict、orchestrator v2 checkpoint + resumeController、web checkpoint-store + runResume + 端点、UI Checkpoints 面板。v1 checkpoint + 纯 replay 不变。

**Architecture:** 见 spec §二裁决。已完成节点从归档结果重放(不重跑/不重扣预算),未完成节点 factory 重建 runner 后续跑。hash 全 TS-core;fail-closed;确定性(注入 clock;deriveId)。node 产出仍过 orchestrator validateResult(信任边界不变)。

**Spec:** `docs/superpowers/specs/2026-08-21-ts-checkpoint-resume-design.md`
**Base:** main @ 7dc7462(SP1-4 全 merge:core/session/orchestrator/adapter/node/web/cli)。

## Global Constraints

- camelCase;不可变 Object.freeze + readonly;确定性(无 Date.now()/Math.random();注入 clock;id 用 deriveId)。
- hash/序列化全 core canonicalJson/sha256;不复刻 Python;不跨语言 replay。
- fail-closed:v2 解析严格;resume 前置校验(spec/input/result 可重建、archivedResults nodeId∈nodes、Σreservation==budget.reservedTokens、committed+reserved≤limit)任一不符抛错拒绝(不半重建)。
- 已完成节点采信归档结果(上次已过 validateResult);续跑只对未完成节点 validateResult。
- v1 checkpoint 语义 + replay 纯性**不变**(纯增量)。
- 测试用 InMemoryStorage / ScriptedModel / spy factory,**不打真实网络**。
- 全量:7 包全绿;`npm run -ws --if-present build` tsc clean;Python 不动(py-ok)。
- 每 task 末尾 commit;前缀 feat/test/chore/fix。

---

## Task 1: core dict 投影(AgentInput/AgentResult/RunEvent)

**Files:** Modify `packages/core/src/result.ts`(+events.ts if RunEvent dict 需要)、`packages/core/src/index.ts`;Create `packages/core/test/dict-roundtrip.test.ts`.

**Interfaces:** 加可序列化投影 + 重建(复用现有 create* 工厂,产出/接受 canonicalJson 友好的 plain object):
- `agentInputToDict(input): object` / `agentInputFromDict(d): AgentInput` —— task/context(ContextPacket[] 各 sourceNodeId/content/trust/edgeType)/sessionId/metadata。fromDict 经 createAgentInput + createContextPacket 重建(校验+freeze)。
- `agentResultToDict(r): object` / `agentResultFromDict(d): AgentResult` —— nodeId/status/output/usage(inputTokens/outputTokens)/events(RunEvent[] 扁平)/spawnProposals/messageProposals/skipContextProposals/error(NodeError|null)。fromDict 经 createAgentResult + createUsage + create*Proposal + createNodeError 重建;events 用 RunEvent 重建 helper(扁平 readonly 记录:sequence/timestamp/nodeId/type/inputHash/outputHash/metadataJson/previousHash/eventHash — freeze 校验后的对象)。
- (若需)`runEventToDict/fromDict`。
- **round-trip 必须 hash-稳定**:agentResultFromDict(agentResultToDict(r)) 的 events 经 verifyEventChain 仍 true;proposals/error 深等。

- [ ] Step 1: 写失败测试 dict-roundtrip.test.ts —— 用现有 core 工厂 + 真实 EventRecorder 事件链构造 AgentResult(含 spawn proposal + FAILED+NodeError 变体)、AgentInput(含 context packet + metadata);断言 toDict→fromDict 深等 + events verifyEventChain 仍 true + 非法 dict fromDict 抛错。
- [ ] Step 2: Run `npx vitest run packages/core/` → FAIL。
- [ ] Step 3: 实现(复用 create*;不重实现 hash)。
- [ ] Step 4: Run → PASS。index 导出。全量 `npx vitest run` 绿(纯增量)。`npm run -w @graph-agent/core build` clean。
- [ ] Step 5: Commit `feat: add serializable dict projections for AgentInput/AgentResult`.

---

## Task 2: node spec dict + SessionBackedMemory

**Files:** Modify `packages/node/src/spec.ts`、Create `packages/node/src/session-memory.ts`、Modify `packages/node/src/index.ts`;Create `packages/node/test/spec-dict.test.ts`、`packages/node/test/session-memory.test.ts`.

**Interfaces:**
- spec.ts: `agentSpecToDict(spec): object` / `agentSpecFromDict(d): AgentSpec` —— identity(AgentIdentity:nodeId/name/role/generation/parentNodeId/trustScore)/budget(NodeBudget:maxTurns/maxToolCalls/maxTotalTokens/timeoutSeconds)/instructions/role?/policy(maxGeneration/maxChildren/allowDirectMessages/allowSkipContext)。fromDict 经 createAgentSpec + createAgentIdentity + createNodeBudget 重建。
- session-memory.ts: `class SessionBackedMemory implements SessionMemory` ctor `{ storage: Storage, clock? }`(Storage type from @graph-agent/session)。
  - `load({nodeId, sessionId})`: key = `${sessionId ?? nodeId}::${nodeId}`;session doc 不存在→[];否则 readMessages(storage, key)→映射 StoredMessage→adapter Message({role,content,toolCalls: toolCallsJson 解析});用 recoverSession/verifyMessageChain 保证完整前缀(中断安全)。
  - `append({nodeId, sessionId, messages})`: key 同上;确保 session open(幂等:exists→否则用 nodeId 派生 minimal AgentIdentity open);逐条 appendMessage(storage, key, {role,content,toolCalls})。
  - role 映射:先读 packages/session message-store.ts 的 MessageRole 允许值;若 session 不含 "context",映射 context→user(记 ledger)。
- index 导出 agentSpecToDict/FromDict、SessionBackedMemory。

- [ ] Step 1: 写失败测试 spec-dict.test.ts(富 AgentSpec toDict→fromDict 深等 + 非法拒绝)、session-memory.test.ts(InMemoryStorage:append 两条→load 深等映射;空 session→[];role 映射;hash 链完整;顺序保持)。
- [ ] Step 2: Run `npx vitest run packages/node/` → FAIL。
- [ ] Step 3: 实现。先读 packages/session/src/{message-store,session,recovery}.ts 确认 MessageRole + appendMessage/readMessages/readSessionDoc/recoverSession 签名。
- [ ] Step 4: Run → PASS。index 导出。全量绿。build clean。
- [ ] Step 5: Commit `feat: add AgentSpec dict projection and SessionBackedMemory`.

---

## Task 3: orchestrator v2 checkpoint + archivedResults + adoptRun

**Files:** Create `packages/orchestrator/src/checkpoint.ts`;Modify `packages/orchestrator/src/{controller,mutable-state,scheduler,index}.ts`;Create `packages/orchestrator/test/checkpoint-v2.test.ts`.

**关键裁决(记 ledger):**
- **依赖方向**:orchestrator 不依赖 node。checkpoint 里 spec 当 **opaque**:buildResumableCheckpoint 直接 canonicalJson 序列化 state.specs.get(nodeId)(已是 frozen plain 记录);parse 返回 spec 为 plain object;resume(T4)用注入的 `rehydrateSpec` 回调把 plain → AgentSpec。input/result 用 core dict(orchestrator→core OK)。
- **per-execution result 归档**:controller 当前只存 processedResults(decisions),不存 AgentResult。为 resume 重放已完成节点,MutableRunState 加 `archivedResults: Map<executionId, AgentResult>`;scheduler ingestLocked 在 settle(有真实 result 的 COMPLETED/FAILED,含 fail-closed 的非法 result 原样)时 set 入。settleException(runner 抛异常,无 result)不归档→resume 视为未完成重跑(记 ledger 语义)。纯增字段,snapshotOf 不投影,SP3 测试不回归。

**Interfaces:**
- mutable-state.ts: 加 `archivedResults: Map<string, AgentResult>`(import type AgentResult from core);createMutableRunState 初始化空。
- scheduler.ts: ingestLocked settle 成功/失败(有 result)路径 `state.archivedResults.set(execution.executionId, result)`。
- checkpoint.ts: `interface ResumableCheckpoint`;`buildResumableCheckpoint(state, events): string`(canonicalJson 7 键:v1 六键 + resumable{nodes:[{nodeId,spec(opaque),input(core dict),toolNames,reservation,state}], archivedResults:[{executionId,nodeId,result(core dict)}], enqueueSequence})。toolNames 从 spec 或 node 记录推(spec.toolNames? — 富 spec 无 toolNames 字段;用 nodeRecord.allowedToolNames)。reservation 从 state.nodeReservations(pending 节点有;已完成节点 0/省略)。`parseResumableCheckpoint(json): { events, finalSnapshot, resumable }`(严格:≤5MB、无重复键、键集恰 7、schemaVersion===2、header 一致;复用 controller 的 dup-key/rebuildEvent helper——把它们从 controller 导出或在 checkpoint.ts 复用 controller-events 的 assertNoDuplicateKeys)。
- controller.ts: `checkpointResumable(runId): Promise<string>`(async,持 globalMutex,调 buildResumableCheckpoint);`adoptRun(runId, state, events): void`(runId 已存在→抛;否则 runs.set;仅 resume 用)。
- index 导出 checkpointResumable、adoptRun、buildResumableCheckpoint、parseResumableCheckpoint、ResumableCheckpoint、createMutableRunState/MutableRunState(若未导出,resume 需要)。

- [ ] Step 1: 写失败测试 checkpoint-v2.test.ts —— 用现有 orchestrator genuine-result fixture 跑小图到收敛;checkpointResumable→parseResumableCheckpoint round-trip(关键字段深等);resumable.archivedResults 含已完成 execution;v1 checkpoint() 不含 resumable、parseResumableCheckpoint(v1)报错;adoptRun 注入后 events(runId) 可读;scheduler:ingest 成功后 state.archivedResults 有该 executionId。
- [ ] Step 2: Run `npx vitest run packages/orchestrator/` → FAIL。
- [ ] Step 3: 实现(mutable-state 加字段→scheduler 归档→checkpoint.ts→controller)。全量回归确认 snapshotOf/validateSnapshot 不受影响。
- [ ] Step 4: Run → PASS。index 导出。全量绿(SP3 不回归)。build clean。
- [ ] Step 5: Commit `feat: add v2 resumable checkpoint and per-execution result archive`.

---

## Task 4: orchestrator resumeController

**Files:** Create `packages/orchestrator/src/resume.ts`、`packages/orchestrator/test/resume.integration.test.ts`;Modify `packages/orchestrator/src/index.ts`.

**Interfaces:** `resumeController(json, factory: NodeFactory, opts: { policy: ControllerPolicy; clock?; rehydrateSpec: (dict: unknown) => AgentSpec }): GraphController`:
1. parseResumableCheckpoint(json)。
2. `GraphController.replay(events)` 纯校验(拓扑 digest + 事件链)。
3. 校验 resumable(fail-closed):每 node.spec rehydrateSpec 成功、node.input agentInputFromDict 成功;archivedResults 每 result agentResultFromDict 成功且 nodeId ∈ finalSnapshot.nodes;Σ(pending node.reservation) == finalSnapshot.budget.reservedTokens;committed+reserved ≤ limit。
4. 建 MutableRunState(createMutableRunState + 填充):status/runId/policy;nodes 从 finalSnapshot(createNodeRecord)—— RUNNING(中断)重置 READY;edges;executions;committed/reserved/superstep 从快照;enqueueSequence 从 resumable。
5. 每 resumable.node:specs.set(rehydrateSpec(spec));inputs.set(agentInputFromDict(input));未完成(重置后 READY)→ runners.set(factory.create({spec,toolNames})) + nodeReservations.set(reservation);已完成→跳过。archivedResults→state.archivedResults(agentResultFromDict)。已完成 execution 不重进 frontier,故 processedResults 可留空(记 ledger)。
6. `new GraphController(factory, opts.policy, opts.clock)`;controller.adoptRun(runId, state, events);return。
7. 调用方 runUntilIdle 续跑。

- [ ] Step 1: 写失败测试 resume.integration.test.ts:
   - spy NodeFactory 记录每次 create 的 nodeId + 每 runner.run 次数;跑 root(spawn child)一个 superstep(root 完成、child READY 未跑);checkpointResumable。
   - resumeController(json, spyFactory2, {policy, rehydrateSpec: agentSpecFromDict});runUntilIdle。
   - 断言:root runner resume 后**未 create/未 run**(采信归档);child create+run 一次;status succeeded;committedTokens 不翻倍;预算不变量保持。
   - 已完成单节点图 resume → 无执行、快照不变(幂等)。
   - v1 checkpoint 传 resumeController → 报错。
   - 篡改:Σreservation≠budget.reservedTokens→拒;archivedResults nodeId∉nodes→拒;坏 spec(rehydrateSpec 抛)→拒。
- [ ] Step 2: Run → FAIL。
- [ ] Step 3: 实现 resume.ts。
- [ ] Step 4: Run → PASS(尤其 spy:已完成不重跑 + 预算不翻倍)。index 导出 resumeController。build clean;全量绿。
- [ ] Step 5: Commit `feat: add factory-driven resumeController for breakpoint resume`.

---

## Task 5: web checkpoint-store + studio session/resume + server 端点

**Files:** Create `packages/web/src/checkpoint-store.ts`;Modify `packages/web/src/{studio,server,index}.ts`;Create `packages/web/test/checkpoint-store.test.ts`、扩展 `packages/web/test/{studio,server}.test.ts`.

**Interfaces:**
- checkpoint-store.ts: `class CheckpointStore` ctor `{ storage: Storage; clock? }`。`save(checkpointJson): Promise<{id, meta}>` —— parseResumableCheckpoint 取 runId/eventCount/nodeCount/status;id=deriveId("ckpt",runId,eventCount,nodeCount);createOnce `checkpoints/${id}.json`(FileExistsError→幂等返回);appendLine `checkpoints/index.log`(canonicalJson meta)。`list(): Promise<CheckpointMeta[]>`(readLines index)。`load(id): Promise<string>`(read,不存在抛)。CheckpointMeta{id,runId,status,nodeCount,eventCount,createdAt}。
- studio.ts:
  - deepSeekFactory 注入 `memory: new SessionBackedMemory({storage})`(storage 由 opts 注入;默认 FileStorage(sessions rootDir),测试注入 InMemoryStorage)。
  - runStudioGraph 收敛后 `checkpoint = await controller.checkpointResumable(runId)`;StudioResult 加 `checkpoint: string`。
  - `runResume(checkpointJson, provider, opts?): Promise<StudioResult>` —— deepSeekFactory(provider, storage+SessionBackedMemory);resumeController(json, factory, {policy: studio 固定 policy, clock, rehydrateSpec: agentSpecFromDict});runUntilIdle;组装 StudioResult(同形状 + 续跑后新 checkpoint)。
- server.ts(复用 strictParseObject/hasExactKeys/Semaphore/sendJson/SECURITY_HEADERS,全 loopback;createServer scope 建 CheckpointStore,opts 可注入 store/runResume):
  - `POST /api/checkpoints` {checkpoint}(string,body 上限适当放宽) → store.save → 200 {id,meta}。
  - `GET /api/checkpoints` → 200 {checkpoints: meta[]}。
  - `GET /api/checkpoints/{id}` → 200 {checkpoint} / 404。
  - `POST /api/checkpoints/resume` {id, provider} → store.load → runResume(json, DeepSeekConfig.fromPayload(provider)) → 200 StudioResult;2-slot semaphore;throw→502;校验 id/provider。
- index 导出 CheckpointStore、runResume。

- [ ] Step 1: 写失败测试:checkpoint-store.test.ts(InMemoryStorage save→list→load round-trip;重复 save 幂等同 id;load 不存在抛)。studio.test.ts 扩展(runStudioGraph 注入 ScriptedModel factory+InMemoryStorage→StudioResult 含 checkpoint 字段可 parse;runResume 用该 checkpoint+scripted→续跑 StudioResult;SessionBackedMemory 注入不报错)。server.test.ts 扩展(POST/GET/GET:id/resume 各端点,注入 stub store/runResume;校验+安全头+跨站+尺寸+throw→502)。
- [ ] Step 2: Run `npx vitest run packages/web/` → FAIL。
- [ ] Step 3: 实现(先读 studio.ts/server.ts 现状)。SessionBackedMemory + agentSpecFromDict from @graph-agent/node。
- [ ] Step 4: Run → PASS。index 导出。build clean;全量绿。
- [ ] Step 5: Commit `feat: add checkpoint store, session-backed studio, and checkpoint HTTP endpoints`.

---

## Task 6: UI Checkpoints 面板 + 全量验证

**Files:** Modify `packages/web/assets/{index.html,app.js}`(必要时 styles.css)。

**Interfaces(纯前端 vanilla,复用现有模式):**
- index.html: 加 `<section id="checkpointsView">`(#graphView 兄弟):「保存当前 checkpoint」按钮 + 列表容器 `#checkpointList`。
- app.js: 替换 704-709 checkpoints 占位 → `showCheckpoints()`(policies 仍 toast)。
  - showCheckpoints():view=checkpoints、隐藏 chat/graph、显示面板、nav active、renderCheckpoints()。
  - renderCheckpoints():GET /api/checkpoints → 列表(runId/status/nodeCount/eventCount + 查看/续跑);顶部保存当前(disabled 若无 state.result?.checkpoint)。
  - 保存当前:POST /api/checkpoints {checkpoint: state.result.checkpoint} → toast + 刷新。
  - 查看(只读):GET /api/checkpoints/{id} → 解析 finalSnapshot → 组最小 StudioResult(snapshot+空 node_results+events+chain_valid)→ state.result=之 → showGraph/renderGraphResult。
  - 续跑:需 provider(state.provider.apiKey,无则弹 dialog)→ POST /api/checkpoints/resume {id, provider} → StudioResult → 同 runTask 渲染 + 入 tasks 历史 + toast。
  - 复用 showToast/setSidebar/fetch。
- [ ] Step 1: 实现 index.html + app.js。可选加一个极小纯函数单测(checkpoint→minimal-StudioResult 投影)。
- [ ] Step 2: `npm run -w @graph-agent/web build` clean;assets 随包(static.ts resolve)。
- [ ] Step 3: **全量验证**(逐条报告):
   - `npx vitest run`(根)→ 7 包全绿,报告总数。
   - `npm run -ws --if-present build` → tsc clean 全 workspace。
   - Python:`PYTHONPATH=src .venv/bin/python -c "import graph_agent.web; print('py-ok')"` + `git status --porcelain src/graph_agent/` 空。
   - **离线闭环测试**:runStudioGraph(ScriptedModel+InMemoryStorage)→checkpoint→CheckpointStore.save→load→runResume(ScriptedModel)→收敛(存/取/续跑闭环,无网络)。
   - **UI 手测**:起 `node packages/cli/dist/cli.js ui --port 8765 --no-browser`;curl GET /api/checkpoints(空)、POST 一个 checkpoint(从离线跑出的)、GET 列表非空、GET :id;报告(真实 DeepSeek 续跑手测由用户在浏览器完成)。
- [ ] Step 4: Commit `feat: add Checkpoints panel UI; wire save/restore/resume end-to-end`.

---

## 成功标准

1. 每节点挂真 Session(SessionBackedMemory),消息历史落 hash 链、可 recoverSession。
2. checkpointResumable v2 存拓扑 + 每节点 spec/input/reservation + 每完成 execution 归档结果;parse round-trip。
3. resumeController:已完成节点不重跑/不重扣(spy 断言),未完成续跑至收敛;v1/篡改/预算不符 fail-closed 拒绝。
4. Studio:save/list/get/resume 端点 + UI Checkpoints 面板(端点测试 + 离线闭环 + 手测)。
5. 7 包全绿,tsc 全 clean,Python 不受影响,v1 checkpoint + replay 纯性不变。

## Self-Review 记录

- **Spec 覆盖**:§三 core dict→T1;node spec dict + SessionBackedMemory→T2;§四 v2 + archivedResults→T3;§五 resumeController→T4;§七 store+studio+server→T5;UI + §九全量→T6。
- **依赖方向裁决**:orchestrator 不依赖 node —— spec 在 checkpoint 里 opaque,resumeController 用注入 rehydrateSpec(web 传 node.agentSpecFromDict);input/result 用 core dict。
- **纯增量**:v1/replay 不变;MutableRunState +archivedResults 纯增字段(snapshotOf 不投影,SP3 不回归,T3 全量回归确认)。
- **占位扫描**:无 TBD。IO/网络全 stub。
- **已知取舍**:settleException 无 result 不归档→resume 重跑该节点(记 ledger);已完成节点 processedResults 留空(不重进 frontier);toolNames 用 nodeRecord.allowedToolNames;role context→user 折叠若 session 不支持(T2 确认后记 ledger);UI 靠端点测试+离线闭环+手测;真实 DeepSeek 续跑手测。
