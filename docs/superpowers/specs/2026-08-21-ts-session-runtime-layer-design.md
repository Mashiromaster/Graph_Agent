# TS 重构:子项目 2「Session 运行时层」设计

状态:设计(自主决策模式,方向遵循既定两层架构)
日期:2026-08-21
借鉴来源:视频设计文档「轻量 Session-first 分层 Multi-Agent 运行时设计」(仅借鉴思路)。地基:子项目 1 `@graph-agent/core`(已合并 main,commit 13dce7a)。

---

## 一、背景与定位

两层架构里,**Session 运行时层在下**:管理**单个 Agent** 的状态与历史——消息历史、一个 active run、多个 open work、崩溃恢复。DAG 编排层(子项目 3)在上,每个 DAG 节点背后挂一个 Session。

本子项目只做 Session 运行时 + 文件持久化 + 崩溃恢复。**不碰** DAG 编排(子项目 3)、适配层/Web(子项目 4)。

复用子项目 1 的地基:`canonicalJson`/`sha256`/`valueHash`、SHA-256 事件链(`EventRecorder`/`RunEvent`/`verifyEventChain`/`GENESIS_HASH`)、fail-closed 守卫、`Usage`/`AgentInput`/`AgentResult`/`NodeStatus` 等纯数据模型。

### 借鉴视频的核心思路(适配本项目)

1. **Session-first,Execution 退位**:不把 "Execution" 当写实体;持久化 `workId`,`executionId` 由查询层确定性映射(只读投影)。
2. **一 Session 一 active run,多 open work**:主 Agent 派发子 Agent 后自身无 active run,仍能响应新消息;子结果回来按 correlation 恢复原 work。
3. **六类权威事实**:SessionDoc、MessageStore、Runtime、Inbox/Outbox Receipt、WorkLedger、ProjectTask(可选,本子项目不做)。其它皆为投影。
4. **不建通用事务数据库**:文件锁 + 原子替换(temp+rename)+ fsync + create-once + 幂等重放做崩溃恢复,而非跨文件事务。
5. **投递闭环**:Inbox 原子去重(put-if-absent)、history-before-ACK、delivery receipt/recovery;至少一次 + 幂等,不承诺物理 exactly-once。

---

## 二、包结构

新增包 `@graph-agent/session`(`packages/session/`,依赖 `@graph-agent/core`)。地基不含 IO;本层是**第一个触碰文件系统**的层,所以把所有 IO 收敛到一个 `storage` 适配接口后面,便于测试用内存实现替换真实磁盘。

```
packages/session/
  package.json          # @graph-agent/session, deps: @graph-agent/core
  tsconfig.json
  src/
    storage.ts          # Storage 接口 + 原子写/create-once/锁原语;FileStorage + InMemoryStorage
    session-doc.ts      # SessionDoc 模型 + 读写
    message-store.ts    # 追加式 hash-chained 消息历史 + 读写 + 校验
    runtime.ts          # RuntimeState(0/1 个 active run)+ 状态机
    work-ledger.ts      # WorkLedger(多 open work + correlation + 幂等 settle)
    inbox.ts            # Inbox/Outbox 幂等投递收据
    session.ts          # Session 门面:聚合六类事实,提供高层 API + 恢复
    recovery.ts         # 崩溃恢复:重放/校验/收敛到一致状态
    ids.ts              # 确定性 ID(workId/receiptId 等,sha256 派生,无随机/时钟依赖)
    index.ts            # 统一导出
  test/                 # 每模块一份 vitest + 崩溃恢复集成测试
```

---

## 三、六类权威事实(本子项目实现 5 类,ProjectTask 延后)

### 3.1 Storage 原语(`storage.ts`)

抽象所有 IO,是崩溃安全的唯一来源:

- `atomicWrite(path, bytes)`:写临时文件 → fsync → rename 到目标(POSIX rename 原子)。
- `createOnce(path, bytes)`:`wx` 语义,已存在则失败——用于 Inbox put-if-absent 去重。
- `appendLine(path, line)`:追加一行 JSON(消息历史/事件日志用 append-only)。
- `read(path)` / `readLines(path)` / `exists(path)` / `list(dir)`。
- `withLock(path, fn)`:基于 create-once 锁文件的互斥;进程崩溃留下的陈旧锁按 create-once + 心跳/时间戳判定接管(时间戳由注入的 clock 提供,便于测试)。
- 两个实现:`FileStorage`(真实磁盘,Node `fs`)、`InMemoryStorage`(测试用,同语义,含可注入的"崩溃点")。

### 3.2 SessionDoc(`session-doc.ts`)

Session 身份与元数据(单文件,原子替换):`sessionId`、`agentIdentity`(复用 core `AgentIdentity`)、`createdAt`、`schemaVersion`、`metadata`。只读 + 原子更新。

### 3.3 MessageStore(`message-store.ts`)

**追加式** hash-chained 消息历史(append-only 日志,复用 core 的事件链思路):每条 `StoredMessage` = 消息内容(role/content/toolCalls,复用 core Message 形状)+ `sequence` + `previousHash` + `entryHash`(= `sha256(canonicalJson(除 entryHash 外字段))`)。`verifyMessageChain` 校验完整性。追加即持久化(history-before-ACK 的"history"就是这里)。

### 3.4 Runtime(`runtime.ts`)

单 Session 的运行时状态机,核心不变量:**至多一个 active run**。
- 状态:`idle`(无 active run)/ `running`(有 active run)。
- `startRun(agentInput) -> runId`:idle→running,写 runtime 文件(原子替换)。已 running 则拒绝(fail-closed)。
- `finishRun(runId, agentResult)`:running→idle,归档结果为只读投影。
- 主 Agent 派发子 Agent 后 `finishRun` 回到 idle,即可 `startRun` 响应新消息——这就是"一 active run + 多 open work"里 active run 的部分。

### 3.5 WorkLedger(`work-ledger.ts`)

**多 open work + correlation + 幂等 settle**(借鉴 Python `execution_id`+`processed_results`):
- `openWork(correlationKey, payload) -> workId`:`workId` 由 `sha256(sessionId|correlationKey|seq)` 确定性派生(`ids.ts`);create-once 落盘,重复 correlationKey 幂等返回同一 workId。
- `settleWork(workId, result)`:put-if-absent 写结果收据;重复 settle 幂等短路(不覆盖)。
- `openWorkItems()`:列出未 settle 的 work。
- `executionId` 不持久化,由 `workId` 确定性映射(只读投影,Execution 退位)。

### 3.6 Inbox/Outbox(`inbox.ts`)

跨 Session 幂等投递收据:
- `putIfAbsent(messageId, envelope)`:create-once;已存在返回"已投递"而不重复(至少一次 + 幂等去重)。
- `ackAfterHistory(messageId)`:先确认消息已进 MessageStore(history-before-ACK),再写 delivery receipt。
- 恢复时:有 history 无 receipt → 重发 receipt;有 receipt → 已完成。不承诺物理 exactly-once,承诺"效果幂等"。

---

## 四、Session 门面(`session.ts`)与恢复(`recovery.ts`)

`Session` 聚合六类事实,提供高层 API:`open`/`load`、`appendMessage`、`startRun`/`finishRun`、`openWork`/`settleWork`、`deliver`(inbox)。所有写操作经 `withLock` + 原子原语,保证单写者语义。

`recovery.ts`:`recoverSession(storage, sessionId)` 崩溃后收敛:
1. 校验 MessageStore hash 链(`verifyMessageChain`),截断到最后一个完整条目。
2. 校验 runtime 文件;若 active run 无对应完整归档 → 标记为中断 run(可重启)。
3. 扫 WorkLedger:未 settle 的 work 保持 open;有结果收据的标记 settled。
4. Inbox:有 history 无 receipt 的重发 receipt。
5. 产出一致的 `Session`;整个过程幂等——重复 recover 结果相同。

**崩溃安全策略**:每个真相源单文件/单目录,写用 temp+rename 原子替换或 create-once;跨文件不做事务,靠"每个事实自洽 + 重放幂等"收敛。注入 clock(承接子项目 1 `EventRecorder(nodeId, clock?)` 的模式)与可注入崩溃点,使恢复路径可确定性测试。

---

## 五、错误处理与校验

延续子项目 1 的 fail-closed 风格:所有模型工厂经 core 守卫校验、`Object.freeze`;非法状态转移(如 running 时再 startRun)抛错;hash 链校验失败即拒绝加载被篡改/损坏的历史。IO 错误显式传播,不静默吞掉。

---

## 六、测试(vitest)

- **Storage**:原子写在"崩溃点"注入下不产生半截文件;createOnce 去重;withLock 互斥 + 陈旧锁接管。
- **MessageStore**:追加链正确;篡改/断链被 `verifyMessageChain` 检出;崩溃截断到最后完整条目。
- **Runtime**:至多一个 active run 不变量;非法转移拒绝;finishRun 归档。
- **WorkLedger**:多 open work;同 correlationKey 幂等;重复 settle 幂等短路。
- **Inbox**:putIfAbsent 去重;history-before-ACK 顺序;有 history 无 receipt 重发。
- **恢复集成测试**:在各写操作中间注入崩溃,recover 后状态一致且幂等(重复 recover 不变)。

---

## 七、明确不做(YAGNI)

- 不实现 DAG 编排/Controller/super-step(子项目 3)。
- 不实现 DeepSeek 适配器/HTTP/web_ui(子项目 4)。
- 不实现 ProjectTask(可选真相源,出现负责人/依赖/截止/正式验收需求时再加)。
- 不建通用事务数据库;不承诺物理 exactly-once。
- 不改动、不删除 Python `src/`(整体重构完成前保留)。

---

## 八、成功标准

1. `@graph-agent/session` 依赖 `@graph-agent/core`,`tsc` 严格模式构建通过。
2. `vitest` 全绿,覆盖:原子写崩溃安全、消息链篡改检测、active-run 不变量、WorkLedger/Inbox 幂等、崩溃恢复幂等收敛。
3. `InMemoryStorage` 与 `FileStorage` 同语义(同一套测试对两者都过)。
4. 提供干净的 `Session` 门面 API 供子项目 3(DAG 层)给每个节点挂 Session。
5. Python `src/` 不受影响。
