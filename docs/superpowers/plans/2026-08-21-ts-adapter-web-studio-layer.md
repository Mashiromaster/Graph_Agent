# 适配层 + Web Studio(子项目 4)实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** 构建 `@graph-agent/adapter`、`@graph-agent/node`、`@graph-agent/web`、`@graph-agent/cli`,并向 `@graph-agent/core` 追加 6 个 model/tool EventType 值。完成 provider + I/O 层:OpenAI 兼容 LLM 适配器(含 DeepSeek)、AgentNode turn loop、tool 系统、session memory、HTTP Studio 服务 + web_ui、CLI。全量 TS 栈自洽,Python 可退役。

**Architecture:** 见 spec。node 产出的 AgentResult(event 链 + result_hash)必须过 SP3 orchestrator 的 `validateResult`(TS 内部自洽)。hash 用 TS-core;确定性(无 Date/random;proposalId 用 deriveId)。fail-closed 贯穿适配器解析、node 异常、web 输入校验。loopback-only + 安全头。

**Spec:** `docs/superpowers/specs/2026-08-21-ts-adapter-web-studio-design.md`
**Base packages:** core(13dce7a)、session(f8f1280)、orchestrator(4c73936) 均已 merge。

## Global Constraints

- camelCase;不可变模型 Object.freeze + readonly;确定性(无 Date.now()/Math.random() 直接调用;时间经注入 clock;proposalId 经 deriveId)。
- hash 全用 core canonicalJson/sha256/EventRecorder/resultBindingHash;不复刻 Python 字节格式;不承诺跨语言 replay。
- fail-closed:适配器构造/响应解析非法即抛(InvalidModelResponse/ModelTransportError);node turn loop 所有异常转 FAILED AgentResult(消息不泄露);web 所有输入严格校验;跨站阻断 + loopback-only + 安全头。
- node 产出必须过 SP3 `verifyEventChain` + `validateResult`(测试里引 orchestrator 断言 round-trip)。
- 工具用**显式 JSON Schema**(不移植 Python 签名反射)。
- **不做**(YAGNI):SSE/WebSocket/流式、checkpoint/step HTTP 端点、多 provider(仅 OpenAI 兼容 + DeepSeek)、签名反射、跨语言 replay、改 Python `src/`、ProjectTask。
- 测试/构建:`npx vitest run`(根);`npm run -ws --if-present build`;每包 `npm run -w <pkg> build`。
- 提交:每 task 末尾 commit,前缀 feat/test/chore。

---

## Task 1: core EventType 补丁 + `@graph-agent/adapter` 骨架 + model-types + model

**Files:** Modify `packages/core/src/events.ts` (+`index.ts` if needed); Create `packages/adapter/{package.json,tsconfig.json}`, `packages/adapter/src/{model-types.ts,model.ts,index.ts}`, `packages/adapter/test/{model-types.test.ts,scripted-model.test.ts}`, and a core test addition `packages/core/test/event-type-additions.test.ts` (or extend existing).

**Interfaces:**
- **core patch (additive):** extend `EventType` const with `MODEL_STARTED:"model_started"`, `MODEL_COMPLETED:"model_completed"`, `TOOL_STARTED:"tool_started"`, `TOOL_COMPLETED:"tool_completed"`, `TOOL_REJECTED:"tool_rejected"`, `PROPOSAL_CREATED:"proposal_created"`. Do NOT change the existing 4 values or any other core code. The `EventType` union widens automatically.
- adapter package.json `@graph-agent/adapter` deps `{ "@graph-agent/core": "*" }`; tsconfig extends base.
- model-types.ts: `MessageRole` union "system"|"user"|"assistant"|"tool"|"context"; `ToolCall {id,name,arguments:Record<string,unknown>}`; `Message {role, content:string|null, toolCalls?, name?, toolCallId?}`; `ToolDefinition {name,description,inputSchema:object}`; `ModelRequest {nodeId,instructions,messages,tools,metadata}`; `ModelResponse {content:string|null,toolCalls,usage:Usage,finishReason:string|null}` (Usage from core). Frozen factories: createMessage/createToolCall/createModelRequest/createModelResponse (validate via core guards where sensible; freeze).
- model.ts: `interface ModelAdapter { complete(request: ModelRequest): Promise<ModelResponse> }`; `class ScriptedModel implements ModelAdapter` (ctor `ModelResponse[]`, FIFO, `requests[]` recorded, throws when exhausted).

- [ ] **Step 1:** Patch core events.ts (add 6 values). Run FULL suite `npx vitest run` → still green (additive; SP1-3 tests must not break). Add a small core test asserting the 6 new values + that the union accepts them. `npm run -w @graph-agent/core build` clean.
- [ ] **Step 2:** Write adapter package.json + tsconfig; `npm install` at root if needed (stage package-lock).
- [ ] **Step 3:** Write failing tests model-types.test.ts (factory freeze + shape) + scripted-model.test.ts (FIFO, records requests, throws when empty).
- [ ] **Step 4:** Run `npx vitest run packages/adapter/` → FAIL.
- [ ] **Step 5:** Implement model-types.ts + model.ts. Run → PASS. Write index.ts.
- [ ] **Step 6:** `npm run -w @graph-agent/adapter build` clean; full suite green.
- [ ] **Step 7:** Commit `feat: add model-turn EventTypes to core and scaffold @graph-agent/adapter`.

---

## Task 2: `@graph-agent/adapter` — transport + OpenAICompatibleModel

**Files:** Create `packages/adapter/src/{transport.ts,openai-compatible.ts}`, `packages/adapter/test/{transport.test.ts,openai-compatible.test.ts}`. Modify index.ts.

**Interfaces:**
- transport.ts: `interface JSONTransport { postJson(args:{url:string;headers:Record<string,string>;payload:unknown;timeoutSeconds:number}): Promise<unknown> }`; `class FetchJSONTransport implements JSONTransport` using global `fetch` + `AbortController` timeout, `redirect:"error"` (no redirects), response byte cap 8 MiB, non-2xx→ModelTransportError(`Model endpoint returned HTTP {code}`), network fail→ModelTransportError(`Could not reach model endpoint`), bad JSON→ModelTransportError(`Model endpoint returned invalid JSON`), non-object→ModelTransportError(`... non-object JSON value`). No retry.
- openai-compatible.ts: `class OpenAICompatibleModel implements ModelAdapter` ctor `{model, apiKey?, baseUrl="https://api.openai.com/v1", timeoutSeconds=60, maxOutputTokens?, extraBody={}, transport?}`. Construction validation per spec §四 (model non-empty; validateBaseUrl absolute http(s)+hostname, non-loopback→https, no query/fragment/user/pass; timeoutSeconds>0; maxOutputTokens positive int; extraBody string-key object, no reserved keys {model,messages,tools,tool_choice,max_tokens}, canonicalJson ≤16384 bytes; apiKey env fallback OPENAI_API_KEY only for host api.openai.com). `complete(req)` builds request + parses response per spec §四 (messagePayload mapping incl. CONTEXT→user, assistant tool_calls with canonicalJson string arguments, tool→tool_call_id; response choices[0].message, function tool_calls, content string|text-parts, usage prompt_tokens/completion_tokens→input/output). Errors `ModelTransportError`, `InvalidModelResponse`.

- [ ] **Step 1:** Write failing transport.test.ts (inject a fake fetch or a stub — assert no-redirect option set, timeout aborts, 8MiB cap rejects, non-2xx→error, non-object→error) + openai-compatible.test.ts (construction rejects each invalid config; complete() builds expected request body via a stub JSONTransport capturing the payload; parses a canned response incl. tool_calls + array content + usage mapping; missing choice→InvalidModelResponse). Use a stub transport (do NOT hit network).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement transport.ts + openai-compatible.ts.
- [ ] **Step 4:** Run → PASS. Update index (export OpenAICompatibleModel, FetchJSONTransport, JSONTransport, ModelTransportError, InvalidModelResponse).
- [ ] **Step 5:** build clean; full suite green.
- [ ] **Step 6:** Commit `feat: add OpenAI-compatible model adapter and fetch transport`.

---

## Task 3: `@graph-agent/node` — tools + graph-tools + memory

**Files:** Create `packages/node/{package.json,tsconfig.json}`, `packages/node/src/{spec.ts,tools.ts,graph-tools.ts,memory.ts,index.ts}`, `packages/node/test/{tools.test.ts,graph-tools.test.ts,memory.test.ts}`.

**Interfaces:**
- package.json `@graph-agent/node` deps `{ "@graph-agent/core":"*", "@graph-agent/adapter":"*", "@graph-agent/session":"*" }` (session for deriveId).
- spec.ts: rich `AgentSpec` `{ identity: AgentIdentity; budget: NodeBudget; instructions: string; role?: string; policy: { maxGeneration:number; maxChildren:number; allowDirectMessages:boolean; allowSkipContext:boolean } }` + `createAgentSpec(input)` (frozen; validate via core guards). This is a SUPERSET of SP3's AgentSpec (orchestrator only reads spec.budget.maxTotalTokens + spec.identity, so structural-compatible).
- tools.ts: `interface Tool { readonly definition: ToolDefinition; invoke(args: Record<string,unknown>): Promise<string> }` (ToolDefinition from adapter); `class FunctionTool implements Tool` ctor `{name, description, inputSchema, fn}` — invoke calls fn, returns string result or canonicalJson(non-string); a thrown fn error propagates (node catches). `class ToolArgumentError extends Error`.
- graph-tools.ts: constants SPAWN_TOOL="graph__propose_spawn"/MESSAGE_TOOL="graph__send_message"/SKIP_CONTEXT_TOOL="graph__request_skip_context"; `GRAPH_TOOL_DEFINITIONS` (3 ToolDefinition, exact JSON schemas per spec §五); `class ProposalCollector` ctor `{spec: AgentSpec, availableToolNames:ReadonlySet<string>}` with spawns/messages/skipContexts arrays; `invoke(name, args, ordinal): {accepted, output, proposal?}` — dispatch, unknown→reject, validation throw→reject(`Rejected graph proposal: ...`), success→append + `{accepted:true, output: canonicalJson({status:"proposed",proposalId,note}), proposal}`. Validation per spec (_spawn generation=identity.generation+1 ≤ policy.maxGeneration/spawns<maxChildren/tool-subset/priority unit/budget_share positive-unit cumulative≤1 → core createSpawnProposal; _message policy.allowDirectMessages/target≠self/ttl int≥1 → createMessageProposal; _skip policy.allowSkipContext/source≠self/context_gate → createSkipContextProposal). proposalId = deriveId(spec.identity.nodeId, kind, ordinal) (deterministic; deriveId from @graph-agent/session).
- memory.ts: `interface SessionMemory { load(args:{nodeId,sessionId}): Promise<readonly Message[]>; append(args:{nodeId,sessionId,messages:readonly Message[]}): Promise<void> }`; `class InMemorySessionMemory` (Map keyed `${nodeId}::${sessionId}` + async mutex).

- [ ] **Step 1:** Write spec.ts. Write failing tools.test.ts (FunctionTool invoke string/non-string/throw), graph-tools.test.ts (each graph tool accept + reject paths: spawn tool-subset/budget-cumulative/depth; message allow-flag/self; skip allow-flag; proposalId deterministic + 64-hex), memory.test.ts (load empty→[], append then load, per-key isolation, concurrent append serialized).
- [ ] **Step 2:** Run `npx vitest run packages/node/` → FAIL.
- [ ] **Step 3:** Implement spec.ts, tools.ts, graph-tools.ts, memory.ts.
- [ ] **Step 4:** Run → PASS. index.ts exports.
- [ ] **Step 5:** build clean; full suite green.
- [ ] **Step 6:** Commit `feat: add node tools, graph-proposal tools, and session memory`.

---

## Task 4: `@graph-agent/node` — AgentNode turn loop (the seam)

**Files:** Create `packages/node/src/agent-node.ts`, `packages/node/test/agent-node.test.ts`. Modify index.ts.

**Interfaces:** `interface NodeRunner { readonly spec: AgentSpec; run(input: AgentInput, signal?: AbortSignal): Promise<AgentResult> }` (AgentInput/AgentResult from core); `class AgentNode implements NodeRunner` ctor `{spec, model: ModelAdapter, tools?: Tool[], memory?, clock?}` — unique tool names, forbid `graph__` prefix on local tools. `run(input, signal?)` implements the FULL turn loop per spec §五: EventRecorder(nodeId, clock) + ProposalCollector; NODE_STARTED; timeout (Promise.race with a timer or AbortController on spec.budget.timeoutSeconds); initial messages (memory.load if memory+sessionId, then CONTEXT per context packet wrapped `"Untrusted context from node {src} (edge={type}, trust={t}):\n{content}"` with name=sourceNodeId, then USER=task); turn loop 1..budget.maxTurns { MODEL_STARTED → model.complete(ModelRequest with tools = local defs + GRAPH_TOOL_DEFINITIONS) → usage += → MODEL_COMPLETED; token over budget → _failure token_budget_exceeded (BUDGET_EXCEEDED); append ASSISTANT if content/toolCalls; if toolCalls: each toolCallsUsed++ over maxToolCalls → _failure tool_budget_exceeded, else _invokeTool + append TOOL msg; continue; else (no toolCalls) → NODE_COMPLETED with metadata.result_hash = resultBindingHash(...) → memory.append optional → return AgentResult COMPLETED }; loop exhausts → _failure turn_budget_exceeded; timeout → _failure timeout retryable; other error → _failure execution_error retryable (generic message). `_invokeTool` + `_failure` per spec §五.

- [ ] **Step 1:** Write failing agent-node.test.ts using ScriptedModel:
   - single-turn complete → AgentResult COMPLETED, events NODE_STARTED..NODE_COMPLETED, **verifyEventChain(result.events) true**, **validateResult(result, nodeId, createControllerPolicy()) === null** (import verifyEventChain from core + validateResult + createControllerPolicy from orchestrator — proves the node's output passes the trust boundary; this is the load-bearing integration assertion).
   - tool call then complete → TOOL events present, two turns.
   - graph tool → PROPOSAL_CREATED event + spawn proposal on result; validateResult null (build a valid gen-1 spawn given a gen-0 root spec + policy).
   - token budget exceeded → FAILED BUDGET_EXCEEDED, result_hash binds error, validateResult null (valid FAILED).
   - tool budget / turn budget exceeded → respective codes.
   - timeout (tiny timeoutSeconds + a model that delays past it) → timeout failure.
   - model throws → execution_error (generic message).
   - ctor forbids graph__ local tool name / duplicate names.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement agent-node.ts.
- [ ] **Step 4:** Run → PASS (esp. validateResult round-trips). index exports AgentNode, NodeRunner.
- [ ] **Step 5:** build clean; full suite green.
- [ ] **Step 6:** Commit `feat: add AgentNode turn loop producing orchestrator-valid results`.

---

## Task 5: `@graph-agent/web` — studio + server + assets

**Files:** Create `packages/web/{package.json,tsconfig.json}`, `packages/web/src/{studio.ts,server.ts,static.ts,index.ts}`, `packages/web/assets/{index.html,styles.css,app.js,favicon.svg}` (ported from Python web_ui), `packages/web/test/{studio.test.ts,server.test.ts}`.

**Interfaces:**
- package.json `@graph-agent/web` deps `{core,orchestrator,node,adapter}`. tsconfig. Ship assets/: the build must make assets available at runtime — either copy assets/ into dist/ as part of build, or resolve the package-root assets dir at runtime via a path derived from import.meta.url. Pick one and verify in Step 6.
- studio.ts: `DeepSeekConfig.fromPayload(obj)` (exact keys {type,api_key,model}; type deepseek; api_key printable-ASCII 8..1024 no surrounding whitespace; model ∈ {deepseek-v4-flash,deepseek-v4-pro}); `parseConversation(list)` (≤40; each exact {role,content}; role user|assistant; alternate user-start assistant-end; content 1..8000 non-blank; total ≤32000); `runStudioGraph(task, provider, conversation, opts?): Promise<StudioResult>` per spec §六. **opts.factory** (optional) injects a NodeFactory so tests use ScriptedModel instead of real network; default builds the DeepSeek factory. StudioResult exact shape per spec §六 (controller_event_chain_valid, elapsed_ms, event_count, events[{hash,sequence,type}], live, node_results[], primary_output, provider{}, snapshot, task). NOTE: elapsed_ms must be deterministic-safe for tests — accept an injected clock or compute from a monotonic source; for tests, allow opts to stub timing so no Date.now in the tested path (or accept elapsed_ms as non-deterministic and exclude it from equality asserts — document the choice).
- static.ts: `staticFile(pathname): {bytes:Buffer|string, contentType:string} | null` mapping `/`,`/index.html`→index.html; `/assets/styles.css`; `/assets/app.js`; `/favicon.svg`. Reads from the package assets dir.
- server.ts: `createServer(opts?: {runGraph?})` Node http; loopback-only bind (createServer/serve reject a non-loopback host); 2-slot semaphore (429 on excess); endpoints GET /api/health, static GET, POST /api/runs per spec §六 (cross-site 403, size 413, content-type 415, slot 429, strict JSON reject dup-keys/NaN, exact {conversation,provider,task} keys, task 1..2000, parseConversation, DeepSeekConfig, 400 on validation error, runGraph (default runStudioGraph) then 200 StudioResult, 502 on throw, security headers on EVERY response). `serve(host, port, {openBrowser?, runGraph?})`.

- [ ] **Step 1:** Port the 4 web_ui files from /Users/mashiro/Project/Graph_Agent/src/graph_agent/web_ui/ into packages/web/assets/ verbatim (index.html, styles.css, app.js). Check for a favicon in that dir; if none, create a minimal favicon.svg. Keep asset paths `/assets/styles.css` and `/assets/app.js` as index.html references them.
- [ ] **Step 2:** Write failing studio.test.ts (DeepSeekConfig each reject + valid; parseConversation each reject + valid; runStudioGraph with an INJECTED ScriptedModel factory → StudioResult shape + controller_event_chain_valid true + snapshot present + node_results populated) + server.test.ts (start on 127.0.0.1:0 or call the request handler directly with a stub runGraph: /api/health shape; static / returns index.html + content-type; /api/runs cross-site→403, oversize→413, bad content-type→415, non-json→400, missing keys→400, valid→200 with stub runGraph canned StudioResult; security headers present on responses; createServer with host "0.0.0.0" throws).
- [ ] **Step 3:** Run `npx vitest run packages/web/` → FAIL.
- [ ] **Step 4:** Implement static.ts, studio.ts, server.ts.
- [ ] **Step 5:** Run → PASS. index exports serve, createServer, runStudioGraph, DeepSeekConfig, parseConversation, StudioResult type.
- [ ] **Step 6:** build clean; verify a real asset loads via static.ts at runtime (a test that reads /index.html bytes non-empty). full suite green.
- [ ] **Step 7:** Commit `feat: add Graph Agent Studio HTTP server and web UI`.

---

## Task 6: `@graph-agent/cli` + 全量验证

**Files:** Create `packages/cli/{package.json,tsconfig.json}`, `packages/cli/src/cli.ts`, `packages/cli/test/cli.test.ts`; package.json "bin" → dist/cli.js.

**Interfaces:** `main(argv: string[], out?: (line:string)=>void): Promise<number>` returning an exit code (inject `out` writer for testability; default console.log). Subcommands:
- `demo`: offline ScriptedModel AgentNode + a multiply FunctionTool + a scripted response containing a multiply tool call + a graph__propose_spawn, then a final "42"; runs node.run; writes result payload JSON; return 0 if no error else 1.
- `controller-demo`: offline GraphController + a demo NodeFactory (children scripted "Review complete") + scripted root proposing a reviewer spawn; createRun→runUntilIdle; writes snapshot.toDict + controller_event_chain_valid; return 0 if status succeeded.
- `ui`: parse --host(127.0.0.1|localhost default 127.0.0.1) --port(int 0..65535 default 8765) --no-browser; call web.serve; return 0 (in tests, do not block — allow injecting a serve stub or use port 0 + immediate close).
- unknown/missing command → non-zero + usage.

- [ ] **Step 1:** package.json `@graph-agent/cli` deps {core, orchestrator, node, adapter, web}; tsconfig; bin.
- [ ] **Step 2:** Write failing cli.test.ts: `main(["demo"], capture)` → 0 and captured output parses to a completed result; `main(["controller-demo"], capture)` → 0 + status succeeded; arg parsing for `ui` (`main(["ui","--port","70000"])` → non-zero invalid port; parse --no-browser) — for the actual serve, inject a serve stub via a module boundary OR test only the parsing by having `ui` accept an injected server factory; unknown command → non-zero. Fully offline (ScriptedModel).
- [ ] **Step 3:** Run → FAIL.
- [ ] **Step 4:** Implement cli.ts (main returns exit code; inject writer + optional serve fn).
- [ ] **Step 5:** Run → PASS.
- [ ] **Step 6: 全量验证** — `npx vitest run` (root): core + session + orchestrator + adapter + node + web + cli ALL green (report total). `npm run -ws --if-present build` tsc clean across ALL workspaces. Confirm dep graph resolves (adapter→core; node→core,adapter,session; web→core,orchestrator,node,adapter; cli→all). Python untouched: `PYTHONPATH=src .venv/bin/python -c "import graph_agent.web; print('py-ok')"` (or skip w/ note). Optional web e2e: start server with injected ScriptedModel factory, real HTTP POST /api/runs → 200 StudioResult (if non-flaky; else note handler-level coverage suffices).
- [ ] **Step 7: Commit** `feat: add graph-agent CLI; complete the TypeScript stack`.

---

## 成功标准

1. adapter/node/web/cli 四包 + core 的 6 值补丁,tsc 严格构建全 workspace 通过。
2. `npm test` 全绿:适配器请求/响应/传输安全;node turn loop 各预算/异常路径 + **产出过 orchestrator validateResult**;web 端点校验 + StudioResult 形状 + 安全头 + loopback-only;CLI demo/controller-demo/ui。
3. node 的 AgentResult 端到端被 orchestrator 接受(node.test 的 validateResult round-trip + 可选 web e2e)。
4. Python `src/` 不受影响(TS 栈自洽)。

## Self-Review 记录

- **Spec 覆盖**:§二裁决A(core EventType)→T1;§四 adapter model-types/model→T1,transport/openai→T2;§五 tools/graph-tools/memory→T3,agent-node→T4;§六 web→T5;§七 CLI + §九全量→T6。
- **占位扫描**:无 TBD。IO/网络 task 一律 stub transport / ScriptedModel / injected factory 测试,不打真实网络。
- **类型一致性**:model-turn 类型在 adapter(裁决B);富 AgentSpec 在 node/src/spec.ts 单一定义(T3 建 T4 复用),SP3 AgentSpec 超集;EventType 补丁纯增量(SP3 validateResult 非终态 type∈值集即过);hash 全 core;proposalId deriveId 确定性;node 产出过 SP3 校验(T4 硬断言)。
- **已知取舍**:favicon.svg 若 Python 无则造最小内联;web 运行时读 assets(dist 含 assets 或运行期从包根读 — T5 Step6 验证);cli main 返回 exit code + 注入 writer/serve 以便测试;elapsed_ms 若含时间,测试用注入 clock 或从相等断言排除(T5 文档化);真实 DeepSeek 端到端不进 CI,以注入 ScriptedModel 的 web e2e 覆盖流程;SP4 后 Python 退役属另一任务。
