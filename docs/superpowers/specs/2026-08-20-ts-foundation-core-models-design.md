# TS 重构:子项目 1「基础设施 + 核心数据模型」设计

状态:设计待批准
日期:2026-08-20
借鉴来源:视频设计文档「轻量 Session-first 分层 Multi-Agent 运行时设计」(design.md, 2026-08-18),仅借鉴思路,不逐字复刻。

---

## 一、背景与整体方向

现有仓库是 Python 实现:`GraphController`(图-DAG 提议模型)、`AgentNode`、DeepSeek 适配器、Web Studio,配套完整测试与 SHA-256 事件链、checkpoint/replay。

决定:**用 TypeScript 全量重构整个项目**,Python 代码逐子项目迁移后退役。新架构采用**两层分工**:

- **DAG 编排层**:表达整个 Agent 系统的架构——Agent 之间怎么派生、依赖、协作、分配预算。沿用现有 `GraphController` 的思路(提议模型 + super-step 归并 + Controller 唯一写入者 + Token 账本 + checkpoint/replay),用 TS 重写。
- **Session 运行时层**:管理单个 Agent 的状态与历史——消息历史、一个 active run、多个 open work、崩溃恢复。借鉴视频里的 Session-first 内核(SessionDoc / MessageStore / Runtime / Inbox-Outbox / WorkLedger)。

两层叠加:**DAG 在上,Session 在下,每个 DAG 节点背后挂一个 Session。**

```
DAG 编排层(Controller 唯一写图)
   节点 A ──spawn──▶ 节点 B ──depends_on──▶ 节点 C
     │                │                     │
   每个节点背后是一个 Session
     ▼                ▼                     ▼
Session 层: SessionDoc / MessageStore / Runtime(activeRun)
            / Inbox-Outbox(幂等投递) / WorkLedger / 恢复
```

### 借鉴视频设计的核心思路(适配本项目)

1. **Session-first,Execution 退位**:不把 "Execution" 当写实体;持久化 `workId`,`executionId` 由查询层确定性映射(只读投影 `AgentExecutionView`),兼容旧 API/UI。
2. **一 Session 一 active run,多 open work**:主 Agent 派发子 Agent 后自身无 active run,仍能响应新用户消息;子结果回来按 correlation 恢复原 work。
3. **六类权威事实**:SessionDoc、MessageStore、Runtime、Inbox/Outbox Receipt、WorkLedger、ProjectTask(可选);其它皆为投影,不新增第七种真相源。
4. **不建通用事务数据库**:靠文件锁 + atomic replace + fsync + create-once + 幂等重放做崩溃恢复,而非跨文件事务。
5. **投递闭环**:Inbox 原子去重(put-if-absent)、history-before-ACK、delivery receipt/recovery;至少一次 + 幂等,不承诺物理 exactly-once。
6. **ProjectTask 可选**:仅在负责人/依赖/截止/共享进度/正式验收出现时才建 Task。

> 说明:上述为整体愿景,写入文档供后续子项目参照。**本 spec 只覆盖子项目 1(地基)**,不实现 Session/DAG 运行逻辑。

---

## 二、整体分解(4 个子项目)

按依赖顺序,每个子项目独立走 spec → plan → 实现:

| # | 子项目 | 交付 | 依赖 |
|---|---|---|---|
| 1 | **TS 基础设施 + 核心数据模型** | monorepo 骨架;纯数据模型 + SHA-256 事件链 + canonical JSON;vitest 测试 | 无 |
| 2 | Session 运行时层 | SessionDoc/MessageStore/Runtime/Inbox-Outbox/WorkLedger/恢复 | 1 |
| 3 | DAG 编排层 | Controller 提议模型/super-step/Token 账本/checkpoint/replay,节点绑 Session | 1, 2 |
| 4 | 适配层 + Web Studio | DeepSeek 适配器/HTTP server/web_ui 迁 TS,端到端跑通 | 1, 2, 3 |

Python `src/` 在对应子项目迁移完成前保持不动,迁完再删。

---

## 三、子项目 1 详细设计

### 3.1 目标

搭好 monorepo TS 骨架,把**与运行时无关的纯数据模型 + 事件链**从 Python 迁到 TS,作为后续两层架构的共享地基。地基不含任何 IO / 运行时逻辑,可完全独立测试。

### 3.2 技术选型

- 运行时/工具链:**Node.js + TypeScript**,`tsc` 构建,`vitest` 测试。
- 仓库结构:新 TS 代码放 `packages/`(npm workspaces);现有 Python `src/` 暂留。

### 3.3 目录结构

```
package.json              # { "workspaces": ["packages/*"], "type": "module" }
tsconfig.base.json        # 严格模式基线配置
vitest.config.ts
packages/
  core/                   # 包名 @graph-agent/core
    package.json
    tsconfig.json         # extends ../../tsconfig.base.json
    src/
      hash.ts             # canonicalJson() + sha256() 工具
      identity.ts         # AgentIdentity
      budget.ts           # NodeBudget, Usage
      result.ts           # AgentInput, AgentResult, NodeError, NodeStatus, ContextPacket
      proposals.ts        # SpawnProposal / MessageProposal / SkipContextProposal
      events.ts           # RunEvent + 事件链 + resultBindingHash + verifyEventChain
      guards.ts           # 运行时校验守卫(有界整数、非布尔、有限数、文本范围)
      index.ts            # 统一导出
    test/
      hash.test.ts
      identity.test.ts
      events.test.ts
      result.test.ts
      proposals.test.ts
      guards.test.ts
```

### 3.4 核心数据模型(与 Python 对应)

全部为 `readonly` interface,构造时 `Object.freeze`(对应 Python `frozen dataclass`)。纯数据,无方法副作用。

| TS 类型 | 对应 Python | 关键字段 |
|---|---|---|
| `AgentIdentity` | `AgentIdentity` | nodeId, name, role, generation, parentNodeId, trustScore |
| `NodeBudget` | `NodeBudget` | maxTurns, maxToolCalls, maxTotalTokens, timeoutSeconds |
| `Usage` | `Usage` | inputTokens, outputTokens (+ 派生 totalTokens) |
| `NodeError` | `NodeError` | code, message, retryable |
| `NodeStatus` | `NodeStatus` (enum) | `'completed'` / `'failed'` |
| `ContextPacket` | `ContextPacket` | sourceNodeId, content, trust, edgeType |
| `AgentInput` | `AgentInput` | task, context, metadata |
| `AgentResult` | `AgentResult` | nodeId, status, output, usage, error, events, *Proposals |
| `SpawnProposal` | `SpawnProposal` | proposalId, parentNodeId, generation, role, objective, instructions, toolNames, budgetShare, priority |
| `MessageProposal` | `MessageProposal` | proposalId, sourceNodeId, targetNodeId, content, ttlSeconds, priority |
| `SkipContextProposal` | `SkipContextProposal` | proposalId, requesterNodeId, sourceNodeId, reason, contextGate |

命名约定:TS 侧统一用 camelCase(如 `nodeId`),这是本次重构的规范,不保留 Python 的 snake_case。

### 3.5 事件链(信任地基)

严格移植 Python `events.py` 的语义,这是 DAG 层与 Session 层共用的信任边界:

- `RunEvent`:type、nodeId、timestamp、inputHash、outputHash、previousHash、eventHash、metadata(+ metadataJson)。
- **hash-chain**:从固定 genesis hash 起,每个事件 `previousHash` 指向上一个的 `eventHash`;`eventHash = sha256(canonicalJson(除 eventHash 外的全部字段))`。
- `resultBindingHash(...)`:绑定 nodeId、status、output、input/outputTokens、三类 proposals、error;写入终态事件的 metadata,供上层校验结果未被篡改。
- `verifyEventChain(events)`:校验链完整性——首事件 previousHash=genesis、逐段链接正确、每个 eventHash 自洽。
- 事件类型枚举:`NODE_STARTED` / `NODE_COMPLETED` / `NODE_FAILED` / `BUDGET_EXCEEDED`(与 Python 对齐)。

### 3.6 canonical JSON

移植 `canonical_json`:键排序、紧凑分隔符 `(",", ":")`、`ensureAscii=false`、禁 NaN/Infinity。保证同一对象在任何环境产出同一字符串,从而 hash 一致(跨语言/跨机可复现)。

### 3.7 校验风格(fail-closed)

延续现有 Python 的严格防御风格,用 TS 类型 + 运行时守卫双保险:

- 整数:有界、非布尔、`Number.isInteger`;非负处按需检查。
- 浮点/权重:`Number.isFinite`、区间 `[0,1]`。
- 文本:非空、去空白后非空、长度上界。
- sha256 字段:64 位十六进制字符串。

守卫集中在 `guards.ts`,抛 `TypeError` / `RangeError`,与现有 Python `_validate_*` 行为等价。

### 3.8 测试(vitest)

逐文件对应,重点等价于现有 Python 测试:

- **事件链**:正常链通过;篡改任一字段/断链/伪造 eventHash 被检出;空链、超长链边界。
- **hash 确定性**:同对象多次 canonicalJson/sha256 稳定;键顺序无关;NaN/Infinity 抛错。
- **resultBindingHash**:字段任一变动 → hash 变;proposals 顺序敏感性符合预期。
- **校验守卫**:布尔冒充整数、超界、非有限数、空文本、非法 sha256 全部 fail-closed。
- **数据模型**:构造后不可变(冻结);派生字段(如 `totalTokens`)正确。

### 3.9 明确不做(YAGNI)

- 不实现 Session、MessageStore、Runtime、Inbox、WorkLedger(子项目 2)。
- 不实现 Controller 运行逻辑、super-step、Token 账本、checkpoint/replay(子项目 3)。
- 不写 DeepSeek 适配器、HTTP server、web_ui(子项目 4)。
- 不改动、不删除现有 Python `src/`。
- 不引入除 TS/vitest 外的运行时依赖(地基应零业务依赖)。

---

## 四、成功标准

1. `npm install` 后 `packages/core` 可 `tsc` 构建通过,严格模式无错误。
2. `vitest` 全绿,覆盖事件链篡改检测、hash 确定性、校验边界。
3. `@graph-agent/core` 可被其它包 `import`,导出全部数据模型与事件链工具。
4. 现有 Python 代码与测试不受影响。
