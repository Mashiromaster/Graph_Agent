# TS 重构:子项目 3「DAG 编排层」设计

状态:设计(自主决策模式,方向遵循既定两层架构)
日期:2026-08-21
借鉴来源:现有 Python `GraphController`(`src/graph_agent/controller.py` 等,已在生产验证的语义)。地基:子项目 1 `@graph-agent/core`(commit 13dce7a)、子项目 2 `@graph-agent/session`(commit f8f1280)。

---

## 一、背景与定位

两层架构里,**DAG 编排层在上**:整个 Agent 系统的架构——Agent 之间怎么派生/依赖/协作/分预算。沿用现有 `GraphController` 思路(提议模型 + super-step 归并 + Controller 唯一写入者 + Token 账本 + checkpoint/replay)。Session 运行时层(子项目 2)在下,**每个 DAG 节点背后挂一个 Session**。

本子项目实现 `@graph-agent/orchestrator`:纯 TypeScript 的图编排内核 + 信任边界 + 预算账本 + 崩溃可复现的 checkpoint/replay。**不碰**适配层/Web(子项目 4);不改 Python `src/`。

复用地基:
- core:`canonicalJson`/`sha256`/`valueHash`、`EventRecorder`/`RunEvent`/`verifyEventChain`/`GENESIS_HASH`/`resultBindingHash`、fail-closed 守卫、`AgentInput`/`AgentResult`/`NodeStatus`/`Usage`/`NodeError`/`ContextPacket`、三类 proposal 模型。
- session:每个物化的 DAG 节点可挂一个 `Session`(消息历史、run、work、崩溃恢复)。节点执行的持久化状态经 Session 落盘。

### 关键设计裁决(interop)

**TS 全量重构是替换,不是共存。** Python `src/` 在整体重构完成后退役,**不要求跨语言 replay**。因此:
- Controller 与 node 的 hash 一律用 **TS-core 的 `canonicalJson`/`sha256`/`EventRecorder`** 作为单一来源,**不**逐字节复刻 Python 的 `repr(timestamp)` / `asdict` 序列化格式。这直接消除了 Python `repr(float)` 时间戳这个最脆弱的 interop 隐患。
- **语义完全保留**(校验清单、预算规则、归并顺序、checkpoint/replay 结构、确定性 ID 派生);**仅 hash 字节格式**改为 TS 原生。
- 代价:若未来需要跨语言 replay,旧 Python checkpoint 无法在 TS 侧复现——可接受,因为 Python 退役。

**确定性 ID:** 复用 session 的 `deriveId(...parts)`(= `sha256(canonicalJson(parts))`,64-hex)。Python 用 `sha256("\x1f".join)[:20]` 前缀 kind;TS 侧统一改为 `deriveControllerId(kind, ...parts)` 全长 64-hex,kind 作为首个 part。语义(确定性、参数顺序敏感)保留,格式 TS 原生。

---

## 二、包结构

新增包 `@graph-agent/orchestrator`(`packages/orchestrator/`,依赖 `@graph-agent/core` + `@graph-agent/session`)。

```
packages/orchestrator/
  package.json          # deps: @graph-agent/core, @graph-agent/session
  tsconfig.json
  src/
    policy.ts           # ControllerPolicy(默认上限常量)+ 校验
    graph-models.ts     # RunStatus/NodeState/ExecutionState/DecisionState/EdgeType 枚举 + NodeRecord/EdgeRecord/ExecutionRecord/ProposalDecision/BudgetSnapshot/RunSnapshot 记录 + (from/to)Dict
    ids.ts              # deriveControllerId(kind, ...parts) 复用 core/session deriveId
    validation.ts       # 结果信任边界:validateResult + validateSpawn/Message/Skip + 文本/unit/tools/sha256 守卫
    budget.ts           # 预算账本运算(reserve/commit/release 的纯函数)
    result-binding.ts   # resultBindingHash 复用 core;terminal 事件 result_hash 绑定校验
    controller-events.ts# ControllerEvent + hash 链 + verifyControllerEventChain + 4 类事件
    mutable-state.ts    # MutableRunState(Controller 私有可变态)
    scheduler.ts        # super-step:frontier 冻结/claim、并发执行、按 sequence 归并、settle
    mutations.ts        # applySpawn/applyMessage/applySkip(在临界区内物化节点/边)
    controller.ts       # GraphController 门面:createRun/runSuperstep/runUntilIdle/addDependency/cancel/checkpoint/replay + 锁
    runner.ts           # NodeRunner / NodeFactory 接口 + 取消令牌约定
    snapshot-validation.ts # validateSnapshot(replay 再校验)
    index.ts            # 统一导出
  test/                 # 每模块 vitest + 归并确定性/信任边界/预算/checkpoint-replay 集成测试
```

---

## 三、图模型(`graph-models.ts` + `policy.ts`)

### 枚举(值即 wire 格式,与 Python 一致)
- `RunStatus`: running/succeeded/failed/cancelled
- `NodeState`: ready/blocked/running/succeeded/failed/cancelled
- `ExecutionState`: queued/running/succeeded/failed/cancelled
- `DecisionState`: accepted/rejected
- `EdgeType`: spawn/depends_on/message/skip_context
- 复用 core `NodeStatus`(completed/failed)——**node 结果状态用 completed,controller 节点状态用 succeeded,映射 load-bearing**。

### 记录(全 readonly + Object.freeze;不可变拷贝替代原地修改)
- `NodeRecord`: nodeId,name,role,parentNodeId,generation,priority,state,allowedToolNames(readonly string[]),allocationTokens
- `EdgeRecord`: edgeId,sourceNodeId,targetNodeId,type,priority=0.5,weight=0.5,ttlSeconds|null,contentHash|null
- `ExecutionRecord`: executionId,nodeId,sequence,state,reservedTokens,committedTokens=0,eventChainHead|null
- `ProposalDecision`: proposalId,proposalType,sourceNodeId,state,code,message,materializedId|null
- `BudgetSnapshot`: limitTokens,committedTokens,reservedTokens,+ availableTokens getter(=limit-committed-reserved)
- `RunSnapshot`: runId,status,nodes[],edges[],executions[],decisions[],budget,pendingExecutions,superstep + `toDict()`/`fromDict()`(canonical 可序列化)

### ControllerPolicy 默认(与 Python 逐字一致)
maxNodes=64, maxEdges=256, maxGeneration=4, maxChildrenPerNode=8, maxTotalTokens=64000, maxConcurrency=4, minTrustScore=0.0, maxProposalsPerResult=32, maxEventsPerResult=512, maxTextLength=16000, maxIdLength=256, maxMessageTtlSeconds=86400。整数字段必须为正整数;minTrustScore ∈ [0,1] 非 bool。

### 边语义
- `spawn`:**触发执行**,物化新 READY 子节点,继承父工具白名单子集、代数+1、预算切片。edge.priority=proposal.priority,edge.weight=proposal.budgetShare。
- `depends_on`:**门控执行**,目标节点在所有 depends_on 源 SUCCEEDED 前不进 frontier;仅能 `addDependency` 加到尚未运行的 READY 目标。默认 priority/weight=0.5。
- `message`:**上下文边**,不触发执行;contentHash=sha256(content),ttlSeconds,priority。
- `skip_context`:**上下文边**,不触发执行;源必须是 requester 的祖先;weight=contextGate,contentHash=sha256(reason)。
- **环检测仅走 spawn+depends_on**(执行边);context 边不参与。

---

## 四、super-step 调度(`scheduler.ts`)—— 确定性核心

1. `runSuperstep(runId)`:取 per-run 锁(single-flight),进入 `_runSuperstepOnce`。
2. **frontier 冻结**(持全局锁):status≠running 直接返回快照;frontier = 所有 READY 且依赖满足(depends_on 源全 SUCCEEDED)的节点;按 **(-priority, nodeId)** 稳定排序;若空则 `blockFailedDependents` + `settleRun` + 快照事件返回。
3. **claim**:每个 frontier 节点 pop reservation(<1 则节点 FAILED 跳过);executionId=deriveControllerId("exec",runId,nodeId,seq);建 RUNNING ExecutionRecord;enqueueSequence++;节点→RUNNING;记 claim。superstep++。**释放全局锁**。
4. **并发执行**(不持锁):`max_concurrency` 限流(async 信号量);`runner.run(agentInput)`;节点自取消 → sentinel `RunnerCancelledError`(当普通异常结果);其它异常捕获为结果值。等所有 claim。
5. **归并**(重取全局锁):**按 controller 分配的 sequence 排序 raw**(不是完成顺序——这是让完成先后无关的规则);依次:异常→`settleException`;否则→`ingestLocked`。然后 `settleRun` + 快照事件,返回快照。
6. 整个 super-step 被取消(controller task cancel)→ `cancelClaims` 释放预留、节点/exec CANCELLED,重抛。
7. 新节点(spawn 物化的子节点)本 step 不执行,进入下一 step。`runUntilIdle` 循环到 `pendingExecutions===0`。

**并发模型:** 单进程、内存态。全局锁(async mutex)+ per-run 锁(single-flight);执行阶段不持锁;Controller 是 MutableRunState 唯一写入者。TS 用 async mutex(承接 session withLock 模式的内部队列)+ 并发限流器。

---

## 五、信任边界(`validation.ts` + `result-binding.ts`)—— fail-closed

`ingestLocked(execution, node, result)`:
1. **幂等**:executionId 已在 processedResults → 返回旧 decisions,不重复处理。
2. `validateResult(...)` 返回错误码 → **fail-closed 整体拒绝**:releaseReservation,commit **整笔** reserved,节点/exec FAILED,processedResults[exec]=[](无部分采纳),execution_settled 事件 code=错误码,返回 []。
3. usage 超预留:actual=usage.totalTokens > reserved → fail-closed 码 `USAGE_EXCEEDS_RESERVATION`。
4. 否则:succeeded commit `min(max(actual,0),reserved)`;failed commit 整笔 reserved。
5. **仅 status===completed** 才处理 proposals,固定顺序:**全 spawn(按序) → 全 message → 全 skip**,各返回 ProposalDecision 追加。
6. 存 processedResults[exec]=decisions。

### validateResult 校验清单(逐条移植,任何异常→`MALFORMED_RESULT`)
1. 类型 + nodeId 匹配 → `SOURCE_MISMATCH`
2. 事件链:非空、有界(≤maxEvents)、每元素 RunEvent、`verifyEventChain` 真 → `INVALID_EVENT_CHAIN`
3. 每事件 nodeId 一致 → `SOURCE_MISMATCH`
4. events[0].type===NODE_STARTED → `INVALID_EVENT_STATE`
5. 终态 vs 状态:completed→终态 NODE_COMPLETED 且 error null;failed→终态∈{NODE_FAILED,BUDGET_EXCEEDED} 且 error 是 NodeError(校验 code/message/retryable);其它状态→`INVALID_NODE_STATUS`
6. 每事件 schema:type 是 EventType;nodeId 一致;metadataJson≤maxText;timestamp 是有限 number;四个 hash 过 sha256hex 校验;metadata 是对象 → `INVALID_EVENT_SCHEMA`
7. output 非 null 则非空文本 ≤ maxText
8. usage:Usage 类型;input/outputTokens 是整数(非 bool);≥0;≤maxUsageTokens → `INVALID_USAGE`
9. 三类 proposal 是数组 → `MALFORMED_RESULT`
10. proposal 总数 ≤ maxProposals → `PROPOSAL_LIMIT`
11. 每 proposal id 非空文本 ≤ maxId
12. **result binding hash**:重算 `resultBindingHash(nodeId,status,output,inputTokens,outputTokens,spawn,message,skip,error)`(复用 core),须等于 `events[-1].metadata.result_hash` → `RESULT_BINDING_MISMATCH`

### validateSpawn / applySpawn
- validateSpawn:SpawnProposal 类型;parentNodeId 匹配;generation===parent.gen+1 且是整数 ≤maxGeneration(`GENERATION_MISMATCH`/`DEPTH_LIMIT`);nodes<maxNodes(`NODE_LIMIT`);edges<maxEdges(`EDGE_LIMIT`);父 spawn 边数<maxChildren(`CHILD_LIMIT`);字段校验(tools/id/priority/budgetShare∈(0,1]/role/objective/instructions)→`MALFORMED_PROPOSAL`;工具子集(`PERMISSION_ESCALATION`);父现有 spawn 边 weight 和 + budgetShare ≤1(`INVALID_BUDGET_SHARE`)。
- applySpawn:childId=deriveControllerId("node",runId,parent,ordinal,proposalId),重复→`DUPLICATE_PROPOSAL`;allocation=max(1,floor(parent.alloc*budgetShare));全局预算门 allocation>available→`TOKEN_BUDGET_EXHAUSTED`;工厂 `factory.create({spec,toolNames})` 异常→`FACTORY_ERROR`(**临界区内同步调用**);物化 READY 节点+spec+runner+input(SPAWN ContextPacket)+reservation+SPAWN 边;子 trust=min(parent,1);gen+1。
- applyMessage/applySkip:见清单(target 存在、非自环、祖先校验等)。

**取消令牌约定(runner.ts):** TS 无原生 task cancel。约定 `NodeRunner.run(agentInput, signal?: AbortSignal)`;controller task 级取消经 AbortController 广播 → `cancelClaims`;节点自取消抛 `RunnerCancelledError` sentinel 当失败结果。工厂 `create` 保持同步(在临界区调用,须快、可信)。

---

## 六、预算账本(`budget.ts`)

数据:`nodeReservations: Map<string,number>`、`committedTokens`、`reservedTokens`;`ExecutionRecord.reserved/committedTokens`。纯函数运算,Controller 单一账本。
- **创建预留**:root allocation=min(spec.budget.maxTotalTokens, policy.maxTotalTokens);child=max(1,floor(parent.alloc*budgetShare)),受全局 available 门控。
- **claim**:pop reservation 进 ExecutionRecord;聚合 reservedTokens 不减(执行期间仍预留)。
- **成功提交**:reservedTokens-=reserved;actual>reserved→commit 整笔(超预算 FAILED);否则 commit min(max(actual,0),reserved),释放未用。
- **失败/非法/异常提交**:reservedTokens-=reserved;commit **整笔** reserved;FAILED。
- **取消/阻塞释放**:reservedTokens-=reservation,**不** commit;CANCELLED/BLOCKED。
- **不变量**:committed≥0,reserved≥0,limit≥1,committed+reserved≤limit;每 exec reserved≥1,0≤committed≤reserved。

---

## 七、Controller 事件链(`controller-events.ts`)—— 独立于 per-node 链

- `ControllerEvent`:sequence,runId,type,detailJson(canonical),previousHash,eventHash,schemaVersion=1;`.detail` 严格解析。
- genesis `CONTROLLER_GENESIS_HASH="0".repeat(64)`;`eventHash=sha256(canonicalJson({detail,previousHash,runId,schemaVersion,sequence,type}))`(TS-core canonicalJson)。
- `verifyControllerEventChain`:每 i schemaVersion===1、runId 恒定、sequence===i、previousHash 链接、eventHash 重算一致、detailJson 严格解析;空链→false。
- 4 类事件:`run_created`(detail {})、`snapshot`(detail {snapshot: toDict()})、`dependency_added`({source,target})、`execution_settled`({nodeId,state,code|committedTokens})。每次状态变更后 append snapshot 事件。

---

## 八、Checkpoint / Replay(`controller.ts` + `snapshot-validation.ts`)

- `checkpoint(runId)`→ canonicalJson({chainHead,eventCount,events,runId,schemaVersion:1,stateDigest=sha256(canonicalJson(snapshot.toDict()))})。
- `replayCheckpoint(json)`(静态):str 且 ≤5_000_000;严格 JSON.parse(拒 NaN/Infinity/重复键);dict 且键集恰为 6 个;schemaVersion===1、events 是数组;重建 events;头一致性(eventCount===len、非空、chainHead===末事件 hash、runId===首事件 runId);`replay(events)`;重算 digest===stateDigest。
- `replay(events)`(静态):`verifyControllerEventChain` 真;首事件 run_created、类型∈4 类;收集 snapshot 事件≥1;每个 `RunSnapshot.fromDict` + `validateSnapshot`;**返回最后一个 snapshot**(snapshot replay,非逐事件归约)。**不调用 agent/model/tool/factory**。
- `validateSnapshot`:runId 匹配非空;node/edge/execution id 唯一且真;边端点∈节点集;exec.nodeId∈节点集;预算不变量;pendingExecutions===count(READY|RUNNING);superstep 整数≥0;每 exec 预算;状态/pending 一致(SUCCEEDED→全节点 SUCCEEDED,非 RUNNING→pending===0)。schema 异常→错误。

---

## 九、节点 ↔ Session 绑定

每个物化节点可选挂一个 `@graph-agent/session` Session(用 storage 注入)。设计上:Controller 物化节点时,以 `deriveControllerId("node",...)` 作为 nodeId,可用同一 id 作为 sessionId 开一个 Session;节点执行的消息历史/run/work 经 Session 落盘,Controller 只消费 `AgentResult`(信任边界不变)。**本子项目提供绑定接口(runner 可接收/使用一个 Session 句柄),但不强制**——保持 Controller 对 runner 的信任边界纯净(Controller 只验证 AgentResult,不读 Session 内部)。Session 绑定是 runner 侧的实现细节 + 一个可选的 `SessionBackedRunner` 便利封装。

## 十、错误处理与校验

延续 fail-closed:所有记录工厂经守卫 + Object.freeze;非法状态转移/篡改链/非法结果整体拒绝;IO/序列化错误显式传播。Controller 是唯一写入者,任何来自 runner 的结果都不可信,经完整 validateResult 才物化。

## 十一、测试(vitest)

- policy/graph-models:默认值、校验、toDict/fromDict round-trip。
- validation:12 条 validateResult 清单逐条(合法通过 + 每种错误码触发);spawn/message/skip 各拒绝路径。
- budget:reserve/commit/release 各路径 + 不变量。
- scheduler:**归并确定性**(乱序完成 → 按 sequence 归并结果与顺序无关);frontier 排序;single-flight;并发限流。
- controller-events:链构建 + 篡改检出 + 4 类事件。
- checkpoint/replay 集成:checkpoint→replay round-trip;篡改 digest/链/键集被拒;replay 不触发 factory(用抛异常的 factory 断言从不被调用)。
- 端到端:一个多代 spawn 图 runUntilIdle 收敛;超预算/非法结果 fail-closed;取消释放预留。

## 十二、明确不做(YAGNI)

- 不实现适配层/DeepSeek/HTTP/web(子项目 4)。
- 不实现分布式 worker、SQLite 事务存储、运行中 resume、人工审批、auto-retry、all/any fan-in、weighted quorum(Python MVP 边界之外)。
- 不逐字节复刻 Python hash 格式(TS-core 原生);不承诺跨语言 replay。
- 不改 Python `src/`。
- ProjectTask 仍不做。

## 十三、成功标准

1. `@graph-agent/orchestrator` 依赖 core+session,tsc 严格构建通过。
2. vitest 全绿:信任边界 12 条清单、预算所有路径、归并确定性、checkpoint/replay 幂等 + 篡改拒绝 + replay 不触发 factory。
3. 一个多代 spawn 图能 runUntilIdle 收敛;fail-closed 与取消/阻塞的预算释放正确。
4. 提供节点↔Session 绑定接口(可选 SessionBackedRunner)供上层使用。
5. Python `src/` 不受影响。
