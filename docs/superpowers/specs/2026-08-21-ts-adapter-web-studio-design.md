# TS 重构:子项目 4「适配层 + Web Studio」设计

状态:设计(自主决策模式,方向遵循既定两层架构)
日期:2026-08-21
借鉴来源:现有 Python `adapters/openai_compatible.py`、`node.py`、`tools.py`、`graph_tools.py`、`memory.py`、`web.py`、`cli.py`、`web_ui/`(已验证语义)。地基:SP1 `@graph-agent/core`(13dce7a)、SP2 `@graph-agent/session`(f8f1280)、SP3 `@graph-agent/orchestrator`(4c73936)。

---

## 一、背景与定位

这是全量重构的**最后一层**:provider + I/O 表面。把一个 agent turn 变成真实的 OpenAI 兼容 HTTP LLM 调用、跑单节点 turn loop、暴露 HTTP 服务 + 浏览器 UI + CLI。完成后 Python `src/` 可退役。

覆盖:LLM 适配器(OpenAI 兼容 /chat/completions,含 DeepSeek)、`AgentNode` turn loop(适配器↔控制器的接缝)、tool 系统(local tools + graph proposal tools)、session memory、HTTP Studio 服务、web_ui 静态资源、CLI。

---

## 二、地基裁决(两处 core/接口调整)

**裁决 A(EventType 扩展 core):** SP1 core 的 `EventType` 只有 4 个节点级值(node_started/node_completed/node_failed/budget_exceeded);但 node turn loop 还记录 model/tool 级事件。SP3 `validateResult` 对**非终态**事件只要求 `type ∈ EventType 值集` + 链完整 + 终态 ∈ {NODE_COMPLETED,NODE_FAILED,BUDGET_EXCEEDED}。因此**向 core `EventType` 追加**(纯增量,不动既有值):`MODEL_STARTED="model_started"`、`MODEL_COMPLETED="model_completed"`、`TOOL_STARTED="tool_started"`、`TOOL_COMPLETED="tool_completed"`、`TOOL_REJECTED="tool_rejected"`、`PROPOSAL_CREATED="proposal_created"`。这样中间事件通过 SP3 校验而无需改校验逻辑。这是 SP4 Task 1 的一个小 core 补丁(附全量测试重跑)。

**裁决 B(model-turn 类型 + AgentSpec):** model-turn 类型(`Message`/`MessageRole`/`ModelRequest`/`ModelResponse`/`ToolCall`/`ToolDefinition`)属于适配器契约,放在新包 `@graph-agent/adapter`,不塞进 orchestration core。节点用的富 `AgentSpec`(在 SP3 最小 `{identity,budget,role?}` 之上加 `instructions` + node-level policy 字段 allow_direct_messages/allow_skip_context/max_generation/max_children)在 `@graph-agent/node` 定义,结构上是 SP3 AgentSpec 的**超集**(orchestrator 只读 `spec.budget.maxTotalTokens` 与 `spec.identity`,超集兼容)。

**裁决 C(工具 schema):** Python `FunctionTool.from_callable` 靠签名反射;TS 无等价物 → TS `FunctionTool` 要求**显式 JSON Schema**(`{name, description, inputSchema}` + async `invoke(args)->string`)。不移植签名反射。

**裁决 D(interop):** 承接 SP3 裁决 —— hash 全用 TS-core `canonicalJson`/`sha256`/`EventRecorder`/`resultBindingHash`;**不逐字节复刻 Python**;不承诺跨语言。node 产出的 event 链 + result_hash 必须能被 TS orchestrator 的 `validateResult` 接受(TS 内部自洽即可)。

---

## 三、包结构

```
packages/adapter/       @graph-agent/adapter  (deps: @graph-agent/core)
  src/model-types.ts    Message/MessageRole/ModelRequest/ModelResponse/ToolCall/ToolDefinition/Usage(复用core)
  src/model.ts          ModelAdapter interface + ScriptedModel
  src/transport.ts      JSONTransport interface + FetchJSONTransport(fetch,no-redirect,8MiB cap,timeout)
  src/openai-compatible.ts  OpenAICompatibleModel + ModelTransportError/InvalidModelResponse
  src/index.ts
packages/node/          @graph-agent/node  (deps: core, adapter)
  src/tools.ts          Tool/ToolDefinition + FunctionTool(显式 schema)
  src/graph-tools.ts    GRAPH_TOOL_DEFINITIONS + ProposalCollector
  src/memory.ts         SessionMemory + InMemorySessionMemory
  src/agent-node.ts     AgentSpec(富) + AgentNode.run(turn loop) + NodeFactory 便利
  src/index.ts
packages/web/           @graph-agent/web  (deps: core, orchestrator, node, adapter)
  src/studio.ts         DeepSeekConfig + parseConversation + runStudioGraph
  src/server.ts         Node http server(端点 + 校验 + 安全头 + 静态资源)
  src/static.ts         web_ui 资源加载(打包在 assets/)
  assets/               index.html / styles.css / app.js / favicon.svg(从 Python web_ui 移植)
  src/index.ts
packages/cli/           @graph-agent/cli  (deps: 上面全部)
  src/cli.ts            graph-agent demo|controller-demo|ui
  bin                   可执行入口
```

---

## 四、适配层(`@graph-agent/adapter`)

### model-types.ts
- `type MessageRole = "system"|"user"|"assistant"|"tool"|"context"`(含 context)。
- `interface ToolCall { id; name; arguments: Record<string,unknown> }`。
- `interface Message { role: MessageRole; content: string|null; toolCalls?: readonly ToolCall[]; name?: string; toolCallId?: string }`。
- `interface ToolDefinition { name; description; inputSchema: object }`。
- `interface ModelRequest { nodeId; instructions; messages: readonly Message[]; tools: readonly ToolDefinition[]; metadata: Readonly<Record<string,unknown>> }`。
- `interface ModelResponse { content: string|null; toolCalls: readonly ToolCall[]; usage: Usage; finishReason: string|null }`(Usage 复用 core)。
- 工厂 + freeze。

### model.ts
- `interface ModelAdapter { complete(request: ModelRequest): Promise<ModelResponse> }`。
- `class ScriptedModel implements ModelAdapter`:构造 `ModelResponse[]`,FIFO pop,记录 `requests[]`,耗尽抛错。

### transport.ts
- `interface JSONTransport { postJson(args:{url;headers;payload;timeoutSeconds}): Promise<unknown> }`。
- `class FetchJSONTransport`:用 `fetch` + AbortController 超时;**禁重定向**(`redirect:"error"`);响应 ≤ 8 MiB(读 body 长度上限);非 2xx → ModelTransportError(HTTP code);网络失败 → ModelTransportError;非 JSON / 非对象 → ModelTransportError。**无重试**。

### openai-compatible.ts
- `class OpenAICompatibleModel implements ModelAdapter`,构造 `{ model; apiKey?; baseUrl="https://api.openai.com/v1"; timeoutSeconds=60; maxOutputTokens?; extraBody={}; transport? }`。
- 构造校验(逐条移植):model 非空;baseUrl rstrip"/" 后 `validateBaseUrl`(绝对 http(s) + hostname;非 loopback 必须 https;无 query/fragment/user/pass);timeoutSeconds>0;maxOutputTokens 若设为正整数;extraBody 是 string-key 对象、不含保留键 {model,messages,tools,tool_choice,max_tokens}、canonicalJson ≤16384 字节;apiKey 缺失且 host===api.openai.com 时读 env `OPENAI_API_KEY`(非 OpenAI host 无 env 回退)。
- `complete(req)`:POST `{baseUrl}/chat/completions`,body = `{model, messages:[{role:system,content:instructions}, ...messagePayload(每条)], ...extraBody, tools?(非空时), max_tokens?}`;header Content-Type + `Authorization: Bearer` 仅当有 key。`messagePayload`:CONTEXT→user;assistant+toolCalls → tool_calls[{id,type:function,function:{name,arguments:canonicalJson(args) 字符串}}];tool→需 toolCallId;否则带 name。响应解析:choices[0].message(缺→InvalidModelResponse);tool_calls 每个 type==function、name、arguments JSON.parse 成对象(空→{});content string|array-of-text-parts;usage prompt_tokens/completion_tokens→input/output;finishReason。
- 错误类 `ModelTransportError`、`InvalidModelResponse`。

---

## 五、节点层(`@graph-agent/node`)

### tools.ts
- `interface Tool { readonly definition: ToolDefinition; invoke(args: Record<string,unknown>): Promise<string> }`。
- `class FunctionTool implements Tool`:构造 `{name, description, inputSchema, fn: (args)=>unknown|Promise<unknown>}`;invoke 调 fn,结果 string 直接返回否则 `canonicalJson`;抛错由调用方(node)捕获。(裁决 C:显式 schema,不反射。)

### graph-tools.ts
- 常量 `SPAWN_TOOL="graph__propose_spawn"`、`MESSAGE_TOOL="graph__send_message"`、`SKIP_CONTEXT_TOOL="graph__request_skip_context"`。
- `GRAPH_TOOL_DEFINITIONS`:3 个 ToolDefinition,JSON schema 逐字移植(propose_spawn: role/objective/instructions 必填 + tool_names 数组 + priority 0..1 + budget_share (0,1];send_message: target_node_id/content 必填 + priority + ttl_seconds≥1;request_skip_context: source_node_id/reason 必填 + context_gate 0..1;均 additionalProperties:false)。
- `class ProposalCollector`:构造 `{spec, availableToolNames: Set<string>}`,内部 spawns/messages/skipContexts 数组。`invoke(name, args): { accepted; output; proposal? }`:按名分派 _spawn/_message/_skipContext;未知→拒;校验抛错→拒(`Rejected graph proposal: ...`);成功 append proposal 返回 `{accepted:true, output: canonicalJson({status:"proposed",proposalId,note:"..."}), proposal}`。校验:_spawn(generation=identity.generation+1 ≤ spec.policy.maxGeneration;spawns 数 < maxChildren;tool_names 是非空字符串数组且 ⊆ availableToolNames;priority unit 默认0.5;budget_share positive-unit 默认0.25;累计 budget_share ≤1)→ 复用 core `createSpawnProposal`;_message(需 spec.policy.allowDirectMessages;target≠self;ttl 整数≥1 默认300)→ core `createMessageProposal`;_skipContext(需 allowSkipContext;source≠self;context_gate 默认0.5)→ core `createSkipContextProposal`。proposalId 用 deriveId(nodeId,"spawn|msg|skip",序号)确定性派生(不用随机 uuid — 承接确定性约束)。

### memory.ts
- `interface SessionMemory { load(args:{nodeId;sessionId}): Promise<readonly Message[]>; append(args:{nodeId;sessionId;messages}): Promise<void> }`。
- `class InMemorySessionMemory`:`Map<string, Message[]>` keyed by `${nodeId}::${sessionId}` + async mutex(承接 session withLock 队列模式)。

### agent-node.ts
- 富 `AgentSpec`:`{ identity: AgentIdentity; budget: NodeBudget; instructions: string; role?: string; policy: { maxGeneration; maxChildren; allowDirectMessages; allowSkipContext } }`(SP3 AgentSpec 超集)。
- `interface NodeRunner`(与 SP3 相同:`{ readonly spec; run(input, signal?): Promise<AgentResult> }`)。
- `class AgentNode implements NodeRunner`:构造 `{spec, model: ModelAdapter, tools?: Tool[], memory?}`;工具名唯一 + 禁 `graph__` 前缀。
- `run(agentInput, signal?)`:严格移植 turn loop —— EventRecorder(nodeId,clock) + ProposalCollector;NODE_STARTED;超时(AbortController/Promise.race with timeoutSeconds);initial messages(memory load + 每 context packet 包一条 CONTEXT `"Untrusted context from node {src} (edge={type}, trust={t}):\n{content}"` + 最后 USER=task);turn 循环 1..maxTurns:MODEL_STARTED → model.complete → usage += → MODEL_COMPLETED;token 超预算 → _failure("token_budget_exceeded",BUDGET_EXCEEDED);有 content/toolCalls 追加 ASSISTANT;有 toolCalls 逐个(tool_calls_used++ 超 maxToolCalls → _failure("tool_budget_exceeded");否则 _invokeTool + 追加 TOOL 消息)后 continue;无 toolCalls(终态)→ NODE_COMPLETED(metadata.result_hash = resultBindingHash(...completed...) via core)→(可选 memory persist)→ 返回 AgentResult COMPLETED。循环耗尽 → _failure("turn_budget_exceeded")。超时→_failure("timeout",retryable);其它异常→_failure("execution_error",retryable,消息不泄露)。
- `_invokeTool(call, collector, recorder)`:TOOL_STARTED;graph__ 前缀→collector.invoke,accepted→PROPOSAL_CREATED 否则 TOOL_REJECTED,再 TOOL_COMPLETED,返回 output;否则查 local tool:未知→TOOL_REJECTED 返回拒绝串;tool 抛→TOOL_REJECTED(metadata error_type)返回泛化失败串;成功→TOOL_COMPLETED 返回 output。
- `_failure(recorder, code, message, retryable, usage, collector)`:终态事件(code 含 "budget"→BUDGET_EXCEEDED 否则 NODE_FAILED)metadata.result_hash = resultBindingHash(...failed, output=null, error=NodeError);返回 AgentResult FAILED + NodeError。
- **绑定契约**:终态 result_hash 绑定整个 AgentResult;TS orchestrator 重算校验。事件序列 + 顺序 + result_hash 必须过 SP3 `validateResult`(TS 内部自洽)。

---

## 六、Web Studio(`@graph-agent/web`)

### studio.ts
- `DeepSeekConfig.fromPayload(obj)`:对象恰 {type,api_key,model};type==="deepseek";api_key 可打印 ASCII 8..1024 无首尾空白;model ∈ {deepseek-v4-flash,deepseek-v4-pro}。
- `parseConversation(list)`:≤40 条,每条恰 {role,content},role ∈ user|assistant,**交替、user 起、assistant 止**,content 1..8000 非空白,总 ≤32000。
- `runStudioGraph(task, provider, conversation): Promise<StudioResult>`:固定 root AgentSpec(中文 orchestrator 指令;budget maxTurns=4/maxToolCalls=4/maxTotalTokens=12000/timeout=90;policy maxGeneration=2/maxChildren=2/no messages/no skip);`_DeepSeekFactory`(child AgentNode,拒 local tools;model=OpenAICompatibleModel(base https://api.deepseek.com,timeout90,maxOutputTokens2048,extraBody{thinking:{type:disabled}}));controller policy(maxNodes5/maxEdges8/maxGeneration2/maxChildrenPerNode2/maxTotalTokens32000/maxConcurrency2/maxProposalsPerResult8);conversation→单 ContextPacket(source "conversation-history",trust0.9,edgeType "conversation");controller.createRun→runUntilIdle→取 events;组装 StudioResult payload。
- StudioResult 形状(UI 契约,逐字):`{controller_event_chain_valid, elapsed_ms, event_count, events:[{hash(12),sequence,type}], live:true, node_results:[{node_id,status,output,usage,error}], primary_output, provider:{endpoint,model,thinking,type}, snapshot: runSnapshotToDict(...), task}`。node_results 由 factory 包装的 `RecordedNode` 收集(每 child 结果摘要入共享 map)。

### server.ts(Node `http`)
- `createServer({...})`:仅绑 loopback(127.0.0.1/localhost 否则抛);默认 host 127.0.0.1 port 8765;`execution slots` = 计数信号量(2),超额 429;`serve(host,port,openBrowser?)`。
- 端点:`GET /api/health`→200 `{models,provider:"deepseek",service:"graph-agent-studio",status:"ok"}`;静态 `/`+`/index.html`→index.html,`/assets/styles.css`,`/assets/app.js`,`/favicon.svg`;其余→404 `{error:"Not found"}`。`POST /api/runs`:path 校验;`Sec-Fetch-Site==="cross-site"`→403;Content-Length 1..64000 否则 413;Content-Type application/json 否则 415;取 slot 否则 429(中文);严格 JSON 解析(拒 NaN/Infinity/重复键 — 复用 orchestrator 已导出的 assertNoDuplicateKeys 思路或本地实现);body 恰 {conversation,provider,task};task str 1..2000;parseConversation;DeepSeekConfig.fromPayload;校验错→400 `{error}`;runStudioGraph;异常→502(中文);成功→200 StudioResult;finally 释放 slot。
- 安全头(每响应):Cache-Control:no-store;严格 CSP(default-src 'self';script-src 'self';style-src 'self';img-src 'self' data:;connect-src 'self';object-src 'none';base-uri 'none';form-action 'self';frame-ancestors 'none');Permissions-Policy;Referrer-Policy:no-referrer;X-Content-Type-Options:nosniff。无 CORS(同源);JSON 输出 sort_keys 紧凑 allow_nan=false ensure_ascii=false 等价(用 canonicalJson)。
- **无 SSE/WebSocket/checkpoint/step 端点**(与 Python 一致 — 一次阻塞 POST 跑完整图)。

### static.ts + assets/
- web_ui 四个文件(index.html/styles.css/app.js/favicon.svg)从 Python `web_ui/` **原样移植**(纯 vanilla,无框架无构建);static.ts 从包内 assets 目录读取(等价 importlib.resources)。UI 契约仅依赖 /api/health + /api/runs 响应形状 + 枚举字符串值(node state/run status ∈ ready|running|succeeded|failed|cancelled|blocked;edge type spawn|depends_on|...)。

---

## 七、CLI(`@graph-agent/cli`)

- `graph-agent demo`:离线 ScriptedModel 节点(两条脚本响应:一条含 multiply 工具调用 + graph__propose_spawn,一条 "42")+ local multiply FunctionTool;打印 result payload;exit 0/1。
- `graph-agent controller-demo`:离线 GraphController + `_DemoFactory`(child 脚本 "Review complete")+ 脚本 root 提议 reviewer spawn;createRun→runUntilIdle→打印 snapshot.toDict + controller_event_chain_valid;exit 0 if succeeded。
- `graph-agent ui`:flags --host(127.0.0.1|localhost,默认127.0.0.1)--port(默认8765,0..65535)--no-browser;调 serve。
- 参数解析用轻量方式(Node util.parseArgs 或最小手写),不引重依赖。bin 入口指向编译产物。

---

## 八、错误处理与校验

延续 fail-closed:适配器构造 + 响应解析严格校验(非法→InvalidModelResponse/ModelTransportError);node turn loop 所有异常转 FAILED AgentResult(不泄露);web 所有输入严格校验(尺寸/类型/枚举/交替);loopback-only + 安全头 + 跨站阻断。node 产出经 SP3 orchestrator 完整 validateResult 才被采信。

## 九、测试(vitest)

- adapter:openai-compatible 构造校验(每条拒绝路径)、请求 body 组装(messagePayload 各 role,含 CONTEXT→user、assistant tool_calls 字符串 arguments)、响应解析(tool_calls/content array/usage 映射/缺 choice→错)、FetchJSONTransport(no-redirect、超时、8MiB、非2xx、非JSON — 用 mock transport/fetch)。ScriptedModel FIFO。
- node:AgentNode.run 用 ScriptedModel 驱动 —— 单 turn 完成、工具调用后再 turn、graph 工具→proposal、token/tool/turn 预算超限→对应 _failure、超时→timeout failure、异常→execution_error;**产出的 event 链 + result_hash 过 SP3 verifyEventChain + validateResult**(引 orchestrator 校验断言 round-trip)。ProposalCollector 各拒绝/接受路径。FunctionTool invoke。InMemorySessionMemory load/append。
- web:DeepSeekConfig/parseConversation 各校验;server 端点(用 Node http 起测试服务器或直接调 handler):health、静态、/api/runs 校验(尺寸/类型/跨站/并发 429/严格 JSON/字段)、成功路径用 stub provider(注入 ScriptedModel factory 避免真实网络)→ StudioResult 形状 + controller_event_chain_valid。安全头存在。loopback-only 绑定拒绝。
- cli:demo/controller-demo 离线跑通、退出码;ui 参数解析(不真起服务或起后立即关)。
- 全量:core+session+orchestrator+adapter+node+web+cli 全绿;tsc 全 workspace clean;Python `src/` 不动(py-ok)。

## 十、明确不做(YAGNI)

- 不做 SSE/WebSocket/流式;不加 checkpoint/step HTTP 端点(Python 也没有)。
- 不做签名反射工具(显式 schema)。
- 不做多 provider(仅 OpenAI 兼容 + DeepSeek Studio;架构支持扩展但不预建)。
- 不承诺跨语言 replay;hash TS 原生。
- 不改 Python `src/`(SP4 完成后可另起清理任务退役 Python — 不在本子项目)。
- ProjectTask 仍不做。

## 十一、成功标准

1. 五个新包(adapter/node/web/cli;core 追加 6 个 EventType 值)tsc 严格构建通过。
2. vitest 全绿:适配器请求/响应/传输安全、node turn loop 各预算/异常路径 + 产出过 orchestrator 校验、web 端点校验 + StudioResult 形状、CLI 跑通。
3. `graph-agent ui` 起本地 Studio,浏览器 UI 能提交任务→DeepSeek→渲染执行图(手测或以 stub 覆盖网络的集成测试)。
4. node 产出的 AgentResult 被 `@graph-agent/orchestrator` 端到端接受(真实图收敛)。
5. Python `src/` 不受影响(整体 TS 栈自洽,Python 可退役)。
