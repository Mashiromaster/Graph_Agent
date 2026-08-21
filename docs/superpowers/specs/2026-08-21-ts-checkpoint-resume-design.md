# TS 子项目 5「可恢复 Checkpoint + Session 状态 + 断点续跑」设计

状态:设计(自主决策模式)
日期:2026-08-21
用户诉求(原话):checkpoint 要保存**拓扑关系 + 每个 agent session 的状态**,以便**从断点直接修复/续跑**。
决策(已确认):完整续跑 (resume) · 文件系统 (FileStorage) · 内核 + UI 全做。
地基:SP1 core / SP2 session / SP3 orchestrator / SP4 adapter+node+web+cli(全 merge,main @ dc376f0)。

---

## 一、现状 vs 目标(为什么需要 v2)

**现状(SP3 checkpoint 是"拓扑+预算审计快照",不是可续跑状态):**
- `checkpoint(runId)` 存:controller 事件链(每个 snapshot 事件含 `runSnapshotToDict` 投影)+ stateDigest。可恢复**拓扑 + 每节点终态**(哪些节点 SUCCEEDED/FAILED、边、执行、聚合预算)。
- `replay/replayCheckpoint` **纯**——不调用 factory/runner,只重建并校验快照,返回最后一个 RunSnapshot。
- **不存**:节点 output 文本、per-node reservation、processedResults、specs、inputs、enqueueSequence。
- 节点↔Session **未接线**(AgentNode 只有 `memory?: SessionMemory` 接口 + 一个非持久化的 InMemorySessionMemory)。

**目标:**
1. **每个 agent session 状态持久化** —— 每个 DAG 节点挂一个真正的 `@graph-agent/session` Session(消息历史 hash 链 + runtime + 崩溃恢复),落 FileStorage。
2. **可续跑 checkpoint** —— checkpoint 除拓扑外,存足够信息续跑:每节点 spec + input + toolNames + reservation;每个已完成 execution 的归档 AgentResult(output+usage+error+proposals)。
3. **断点续跑** —— 从 checkpoint 重建 controller,已完成节点用归档结果重放(**不再调 runner、不再扣预算**),未完成/失败节点用 factory 重建 runner 后 `runUntilIdle` 续跑。
4. **UI** —— 左侧 Checkpoints 面板:列表 / 恢复(只读查看快照)/ 续跑。

---

## 二、关键设计裁决

**裁决 A(checkpoint schema v2,向后兼容):** 现 v1 checkpoint 保留、`replay/replayCheckpoint` 保持纯不变。新增 **v2**:在 v1 六键之外加一个 `resumable` 段(顶层第 7 键,仅 schemaVersion≥2 出现):
```
resumable: {
  nodes: [{ nodeId, spec: <AgentSpecDict>, input: <AgentInputDict>, toolNames: string[], reservation: number, state: NodeState }],
  archivedResults: [{ executionId, nodeId, result: <AgentResultDict> }],  // 仅已 settle 的 execution
  enqueueSequence: number
}
```
其中 spec/input/result 用**可序列化投影**(见裁决 C)。v1 checkpoint(无 resumable)仍可 `replayCheckpoint`(只读快照);v2 才能 `resume`。

**裁决 B(节点↔Session 真接线,SessionBackedMemory):** 新增 `SessionBackedMemory implements SessionMemory`(在 `@graph-agent/node`,依赖 `@graph-agent/session`),用注入的 `Storage` + sessionId 把 adapter `Message` ↔ 会话 `MessageStore`(`appendMessage`/`readMessages`,`Message`↔`MessageInput`/`StoredMessage` 映射)。每个 AgentNode 用它持久化/加载消息历史。key = `${runId}::${nodeId}`(每节点一 session dir)。studio 的 factory 注入之。这样"每个 agent session 的状态"真正落盘 + 可 `recoverSession` 恢复。

**裁决 C(可序列化投影 + 重建):** AgentSpec/AgentInput/AgentResult 需 dict 化 + 重建工厂(frozen 记录,含嵌套 ContextPacket/proposals/events)。
- orchestrator 的 runner.ts `AgentSpec` 是最小 `{identity,budget,role?}`;studio 用 node 的**富 AgentSpec**(+instructions+policy)。**resume 需富 spec 才能重建 AgentNode**。因此 resumable.nodes[].spec 存**富 AgentSpec 投影**;重建时 factory 从它 create runner。node 加 `agentSpecToDict/agentSpecFromDict`;core 加 `agentInputToDict/fromDict`、`agentResultToDict/fromDict`(复用现有 create* 工厂;AgentResult 含 events[],RunEvent 已是扁平记录,可直接 JSON;proposals dict 化)。
- 已完成节点重放:resume 不重跑 runner,而是把归档 AgentResult 直接当作该节点"已产出结果",re-seed 到 MutableRunState(node SUCCEEDED/FAILED、execution settled、committedTokens 累加**按归档值**、processedResults 从归档 decisions 恢复)。**关键:不重新 validateResult、不重新扣预算**——归档结果来自上一次 controller 采信过的结果,直接采信。

**裁决 D(resume 是新路径,非纯 replay):** 加模块级 `resumeController(json, factory, opts): GraphController`(在 orchestrator)。它:
1. `replayCheckpoint` 校验 v1 部分(拓扑 digest、事件链)——复用现有纯校验。
2. 校验 v2 resumable 段(每节点 spec/input 可重建、archivedResults 引用的 nodeId ∈ 拓扑、reservation 和 == budget.reservedTokens)。
3. 重建 MutableRunState:最终快照恢复 nodes/edges/budget;已完成节点从 archivedResults re-seed(execution settled + committed);pending/中断节点 `factory.create({spec,toolNames})` 重建 runner + 恢复 spec/input/reservation;重建 processedResults/nodeReservations/enqueueSequence;通过受控入口 `adoptRun(runId,state,events)` 注入 controller。
4. 返回可 `runUntilIdle` 续跑的 controller。resume 后只执行 READY 未完成节点(已完成 state=SUCCEEDED,不进 frontier;上次 RUNNING 无归档=中断→重置 READY 重跑)。

**裁决 E(interop):** hash/序列化全 TS-core canonicalJson/sha256;不跨语言。resume 只吃本 TS 栈产出的 v2 checkpoint。

---

## 三、包与文件变更(SP5 是对现有 6 包的增量,不新增顶层包)

```
packages/core/src/
  result.ts   +agentInputToDict/FromDict, agentResultToDict/FromDict (复用 create*; RunEvent 扁平 JSON; proposals dict)
  index.ts    +导出
packages/node/src/
  spec.ts            +agentSpecToDict/FromDict(富 AgentSpec)
  session-memory.ts  (新) SessionBackedMemory implements SessionMemory,用 Storage+MessageStore
  index.ts           +导出
packages/orchestrator/src/
  checkpoint.ts (新) v2 组装/解析:buildResumableCheckpoint(state,events), parseResumableCheckpoint(json), ResumableCheckpoint 类型
  resume.ts (新)     resumeController(json, factory, opts) 重建 MutableRunState + re-seed 完成节点 + 重建 runners + adoptRun
  controller.ts      +checkpointResumable(runId):string(v2);+adoptRun(runId,state,events) 受控注入入口(resume 用);暴露内部 state 收集(processedResults/nodeReservations/specs/inputs 已在 MutableRunState)
  index.ts           +导出
packages/web/src/
  studio.ts            factory 注入 SessionBackedMemory;runStudioGraph 产出含 v2 checkpoint 字段的 StudioResult;+runResume(checkpointJson, provider, opts)
  checkpoint-store.ts  (新) FileStorage:saveCheckpoint(json)->{id,meta}, listCheckpoints()->meta[], loadCheckpoint(id)->json
  server.ts            +POST /api/checkpoints、GET /api/checkpoints、GET /api/checkpoints/:id、POST /api/checkpoints/resume;checkpoint-store 在 createServer scope 注入
packages/web/assets/
  index.html  +#checkpointsView
  app.js      showCheckpoints()/renderCheckpoints();替换占位 toast;save/list/restore/resume fetch
```

---

## 四、Checkpoint v2 格式与校验

`checkpointResumable(runId)` → canonicalJson,7 键:`{ chainHead, eventCount, events, runId, schemaVersion:2, stateDigest, resumable }`。前 6 键同 v1(stateDigest = sha256(canonicalJson(runSnapshotToDict(最终快照))))。`resumable` 见裁决 A。`parseResumableCheckpoint` 严格(≤5MB、无重复键、键集恰 7、schemaVersion===2、events 数组、header 一致)。v1(6 键)走旧 `replayCheckpoint` 只读,不能 resume(明确报错"v1 checkpoint 不含续跑状态")。

**resume 预算不变量(关键):** 已完成节点 committed 已含在快照 committed;pending 节点 reservation 从 resumable 恢复到 nodeReservations,聚合 reservedTokens = Σ pending reservation,resume 时断言 == 快照 budget.reservedTokens 且 committed+reserved ≤ limit,不符 fail-closed。续跑不重复 commit 已完成节点。

---

## 五、断点续跑流程(resumeController)

输入:v2 JSON + factory + policy(存入 resumable 或从 budget.limit 反推)+ clock。
1. parseResumableCheckpoint → { events, finalSnapshot, resumable }。
2. `GraphController.replay(events)` 纯校验事件链 + 拓扑 digest。
3. 校验 resumable:spec/input/result 可重建;archivedResults nodeId ∈ nodes;Σreservation == budget.reservedTokens(fail-closed)。
4. 建 MutableRunState:runId/policy/status/nodes/edges/executions/committed/reserved/enqueueSequence 从快照+resumable。
5. 每 node:specs.set(agentSpecFromDict);inputs.set(agentInputFromDict);未完成(READY/RUNNING→重置 READY)→ runners.set(factory.create({spec,toolNames})) + nodeReservations.set(reservation);已完成→不建 runner/不设 reservation。
6. processedResults 从 archivedResults 的 decisions 重建(execution→decisions),续跑对这些 execution 幂等。
7. adoptRun(runId, state, events) 注入 controller。
8. 返回 controller;`runUntilIdle` 续跑——只未完成 READY 执行;中断(上次 RUNNING 无归档)重置 READY 重跑(预算按 reservation 重扣,正确——上次没 commit);已归档采信跳过。

---

## 六、节点 Session 状态(SessionBackedMemory)

- `class SessionBackedMemory implements SessionMemory` ctor `{ storage: Storage, clock? }`。
- `load({nodeId,sessionId})`: key=`${sessionId ?? nodeId}::${nodeId}`;session.json 不存在→[];否则 readMessages→StoredMessage[]→adapter Message[](role/content/toolCallsJson→toolCalls)。
- `append({nodeId,sessionId,messages})`: 确保 session open(幂等/exists 判断);逐条 appendMessage({role,content,toolCalls})。
- studio factory 注入 `new SessionBackedMemory({storage: fileStorage})`;AgentNode turn loop 起点 load、终点 append(现有 hooks agent-node.ts:177/307,只是没注入 memory)。
- messages.log hash 链;`recoverSession` 校验+截断恢复——满足"每个 agent session 的状态"持久化 + 崩溃安全。resume 时节点重建后从磁盘 load 到之前历史。

---

## 七、Web + UI

**checkpoint-store.ts:** FileStorage(rootDir 注入)。`saveCheckpoint(json)`:id=deriveId("ckpt",runId,eventCount)(确定性);createOnce `checkpoints/${id}.json`(重复幂等);append meta 行到 `checkpoints/index.log`({id,runId,createdAt(注入 clock 或 0),status,nodeCount})。`listCheckpoints()`:readLines index。`loadCheckpoint(id)`:read。

**studio 产出 v2:** runStudioGraph 在收敛后 `checkpointResumable(runId)`,把它作为 StudioResult 新字段 `checkpoint`(v2 json string)返回,UI 存的时候原样 POST。

**server.ts 新端点(复用 strictParseObject/hasExactKeys/Semaphore/sendJson/SECURITY_HEADERS,全 loopback):**
- `POST /api/checkpoints` body {checkpoint} → store.save → {id,meta}。
- `GET /api/checkpoints` → {checkpoints: meta[]}。
- `GET /api/checkpoints/:id` → {checkpoint}(restore 只读)。
- `POST /api/checkpoints/resume` body {id, provider} → load → runResume(json, provider) → StudioResult(续跑新快照+新 checkpoint)。走 2-slot semaphore、502-on-throw。

**runResume(checkpointJson, provider, opts?):** provider 建 deepSeekFactory(注入 SessionBackedMemory);resumeController;runUntilIdle;组装 StudioResult(同形状 + checkpoint 字段)。

**UI:**
- Checkpoints nav → showCheckpoints()(替换 704-709 占位)。
- `#checkpointsView`(#graphView 兄弟):列表(id/runId/status/nodeCount/时间 + 查看/续跑)+ 保存当前按钮。
- renderCheckpoints():GET 列表。查看→GET :id→快照塞 state.result→showGraph(只读)。续跑→用当前 provider→POST resume→StudioResult→同 runTask 渲染 + 入历史。保存当前→state.result.checkpoint 存在→POST→toast+刷新。

---

## 八、错误处理与不变量(fail-closed)

- v2 解析严格(键集/schemaVersion/尺寸/重复键/header)。
- resume 前置:spec/input/result 可重建;archivedResults nodeId ∈ nodes;Σreservation == budget.reservedTokens;committed+reserved ≤ limit。任一不符→抛错拒绝(不半重建)。
- 已完成节点采信归档结果(上次已过 validateResult);续跑只对未完成节点执行 + validateResult(信任边界不变)。
- SessionBackedMemory:messages.log hash 链;load 经 verifyMessageChain/recoverSession 截断到最后完整条目。
- web:全端点 loopback + 安全头 + 严格校验 + 502-on-throw;checkpoint-store createOnce 幂等。

## 九、测试(vitest)

- core:agentInput/Result toDict↔fromDict round-trip(含 context packets、proposals、events);RunEvent round-trip。
- node:agentSpec dict round-trip;SessionBackedMemory(append→load round-trip via InMemoryStorage,映射正确,空→[],hash 链完整)。
- orchestrator:checkpointResumable v2 + parseResumableCheckpoint round-trip;**resume 集成** —— 2 节点图(root spawn child)跑到 child 未跑,checkpointResumable,resumeController+runUntilIdle → 收敛且**已完成 root 不重跑**(spy factory 断言 root 不再 create/run)、child 跑完、committed 不翻倍;"已完成图"resume→幂等;v1 传 resume→报错;篡改 resumable/spec→拒绝。
- web:checkpoint-store save/list/load(InMemoryStorage);server 新端点(注入 stub runResume/ScriptedModel factory,无网络)——校验+StudioResult 形状+安全头;loopback-only。
- 全量:7 包全绿;tsc 全 workspace clean;Python 不动(py-ok)。UI 手测(起 ui,保存→列表→续跑)。

## 十、明确不做(YAGNI)

- 不做增量/流式 checkpoint(每次全量 v2)。
- 不做跨语言 replay;resumeController 与 provider 无关(仅 Studio 路径用 DeepSeek)。
- 不做 checkpoint GC/保留策略(列表无限增长——backlog)。
- 不改 v1 checkpoint 语义 / replay 纯性。
- 不做分布式;单进程 FileStorage。不动 Python `src/`。

## 十一、成功标准

1. 每节点挂真 Session(SessionBackedMemory),消息历史落 FileStorage hash 链、可 recoverSession。
2. checkpointResumable(v2)存拓扑+每节点 spec/input/reservation+每完成 execution 归档结果;parse+校验 round-trip。
3. resumeController 从 v2 重建并续跑:已完成节点不重跑/不重扣(spy 断言),未完成执行至收敛;预算与信任边界不变量保持。
4. Studio:保存/列表/查看/续跑端点 + UI Checkpoints 面板(手测 + stub 集成)。
5. 7 包全绿,tsc 全 clean,Python 不受影响。
