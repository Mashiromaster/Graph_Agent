/**
 * Anthropic 原生 Messages API(`/v1/messages`)适配器。
 *
 * ## 为什么需要它
 *
 * 本项目原有的 `OpenAICompatibleModel` 走 `/v1/chat/completions`。实测当前端点
 * (JD Cloud 的 Anthropic 代理)对该路径返回 `HTTP 400 "Account invalid"`,而对
 * `/v1/messages` 返回 200。两种 API 的线格式差异不是换个 URL 能抹平的:
 *
 *   - system prompt 是**顶层参数**,不是 messages 里的一条;
 *   - 响应是 content **块数组**(text / thinking / tool_use),不是单个 message;
 *   - 工具结果作为 user 消息里的 `tool_result` 块回传,不是独立的 `role: "tool"`;
 *   - 工具 schema 字段叫 `input_schema`,不是嵌在 `function.parameters` 里;
 *   - usage 字段是 `input_tokens`/`output_tokens`,不是 `prompt_tokens`/`completion_tokens`。
 *
 * ## thinking 块必须原样回传
 *
 * 实测该端点在带 tools 的请求上会返回 `thinking` 块。Anthropic 的多轮工具调用
 * 要求把上一轮的 assistant 内容**连同 thinking 块一起**原样放回下一轮请求,
 * 否则签名校验失败或行为退化。但本项目的 `ModelResponse` 协议只承载
 * `content`/`toolCalls`/`usage`/`finishReason`——没有 thinking 的位置。
 *
 * 解决方式:适配器**按 nodeId 在内部缓存**每轮的原始 assistant 块,并在后续
 * 请求里按 messages 的历史位置重放。这让 thinking 块对上层完全透明,既不污染
 * 核心协议,也不破坏多轮工具调用。缓存键为 nodeId——同一节点的 turn loop 是
 * 严格串行的(见 agent-node 的 `_loop`),故无并发写同一键的风险。
 *
 * 另一条路是关掉 thinking,但该端点的 thinking 似乎是默认行为而非可选项,
 * 且关掉会改变被测模型的实际行为——实验要测的是模型的真实表现,不是被削弱
 * 后的版本。故选择承载它。
 *
 * ## 确定性
 *
 * 无 Date/random。内部缓存只影响发往远端的请求体,不进入 `ModelResponse`,
 * 故 RecordingModel 记录的 (request → response) 对仍是完整的重放依据。
 */

import { assertFinitePositive, createUsage } from "@graph-agent/core";
import type { Message, ModelRequest, ModelResponse, ToolCall } from "./model-types.js";
import { createModelResponse, createToolCall } from "./model-types.js";
import type { ModelAdapter } from "./model.js";
import { FetchJSONTransport, InvalidModelResponse } from "./transport.js";
import type { JSONTransport } from "./transport.js";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const ANTHROPIC_VERSION = "2023-06-01";

/** 与 openai-compatible.ts 同口径的 baseUrl 校验(避免凭据经 URL 泄漏等问题)。 */
function validateBaseUrl(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`baseUrl is not a valid URL: ${baseUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("baseUrl must use http or https");
  }
  if (!url.hostname) {
    throw new Error("baseUrl must have a hostname");
  }
  if (!LOOPBACK_HOSTS.has(url.hostname) && url.protocol !== "https:") {
    throw new Error("baseUrl must use https for non-loopback hosts");
  }
  if (url.search) {
    throw new Error("baseUrl must not contain a query string");
  }
  if (url.hash) {
    throw new Error("baseUrl must not contain a fragment");
  }
  if (url.username || url.password) {
    throw new Error("baseUrl must not contain credentials");
  }
  return url;
}

/** 一个原始 content 块(透传用,不解释其内部结构)。 */
type RawBlock = Record<string, unknown>;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface AnthropicMessagesOptions {
  readonly model: string;
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly maxOutputTokens: number;
  readonly timeoutSeconds?: number;
  readonly temperature?: number;
  readonly transport?: JSONTransport;
}

export class AnthropicMessagesModel implements ModelAdapter {
  private readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly maxOutputTokens: number;
  private readonly timeoutSeconds: number;
  private readonly temperature: number | undefined;
  private readonly transport: JSONTransport;
  /**
   * nodeId → 该节点历次 assistant 回复的原始块序列。
   * 用于多轮工具调用时原样回传 thinking/tool_use 块。
   */
  private readonly assistantTurns = new Map<string, RawBlock[][]>();

  constructor(opts: AnthropicMessagesOptions) {
    if (opts.apiKey.trim().length === 0) {
      throw new Error("apiKey must be non-empty");
    }
    const url = validateBaseUrl(opts.baseUrl);
    this.model = opts.model;
    this.apiKey = opts.apiKey;
    // 去掉尾斜杠,避免拼出 `//v1/messages`。
    this.baseUrl = url.toString().replace(/\/+$/, "");
    this.maxOutputTokens = assertFinitePositive(opts.maxOutputTokens, "maxOutputTokens");
    this.timeoutSeconds = assertFinitePositive(opts.timeoutSeconds ?? 120, "timeoutSeconds");
    this.temperature = opts.temperature;
    this.transport = opts.transport ?? new FetchJSONTransport();
  }

  /** 隐藏凭据,防止 repr/日志泄漏(与 OpenAICompatibleModel 一致)。 */
  toString(): string {
    return `AnthropicMessagesModel(model=${this.model})`;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const turns = this.assistantTurns.get(request.nodeId) ?? [];
    const messages = this.buildMessages(request.messages, turns);

    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: this.maxOutputTokens,
      messages,
    };
    if (request.instructions.trim().length > 0) {
      body.system = request.instructions;
    }
    if (this.temperature !== undefined) {
      body.temperature = this.temperature;
    }
    if (request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }));
    }

    const raw = await this.transport.postJson({
      url: `${this.baseUrl}/v1/messages`,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      payload: body,
      timeoutSeconds: this.timeoutSeconds,
    });

    return this.parseResponse(raw, request.nodeId);
  }

  /**
   * 把核心协议的扁平 messages 翻译为 Anthropic 的块结构。
   *
   * 核心协议里 `role: "tool"` 是独立消息;Anthropic 要求它作为 user 消息里的
   * `tool_result` 块。连续的 tool 消息会被合并进同一条 user 消息——Anthropic
   * 要求一次 assistant 的多个 tool_use 对应的结果在同一条 user 消息里。
   *
   * assistant 消息优先使用缓存的原始块(含 thinking),缓存缺失时退化为纯文本。
   */
  private buildMessages(
    history: readonly Message[],
    turns: readonly RawBlock[][],
  ): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    let assistantIndex = 0;
    let pendingToolResults: RawBlock[] = [];

    const flushToolResults = (): void => {
      if (pendingToolResults.length > 0) {
        out.push({ role: "user", content: pendingToolResults });
        pendingToolResults = [];
      }
    };

    for (const message of history) {
      if (message.role === "tool") {
        pendingToolResults.push({
          type: "tool_result",
          tool_use_id: message.toolCallId ?? "",
          content: message.content ?? "",
        });
        continue;
      }
      flushToolResults();

      if (message.role === "assistant") {
        const cached = turns[assistantIndex];
        assistantIndex += 1;
        if (cached !== undefined && cached.length > 0) {
          // 原样回传(含 thinking 与 tool_use 块及其签名)。
          out.push({ role: "assistant", content: cached });
        } else if (message.content !== null && message.content.length > 0) {
          out.push({ role: "assistant", content: message.content });
        }
        continue;
      }

      // system 角色在 Anthropic 里是顶层参数;历史中若出现则并为 user 文本,
      // 以免整条消息被静默丢弃。
      const role = message.role === "system" ? "user" : message.role;
      if (message.content !== null && message.content.length > 0) {
        out.push({ role, content: message.content });
      }
    }
    flushToolResults();

    // Anthropic 要求 messages 非空;AgentNode 总会附上任务文本,故正常不触发。
    if (out.length === 0) {
      out.push({ role: "user", content: "(no content)" });
    }
    return out;
  }

  /** 解析 content 块数组为核心协议的 ModelResponse,并缓存原始块。 */
  private parseResponse(raw: unknown, nodeId: string): ModelResponse {
    if (!isObject(raw)) {
      throw new InvalidModelResponse("response must be a JSON object");
    }
    if (raw.type === "error") {
      const error = isObject(raw.error) ? String(raw.error.message ?? "") : "";
      throw new InvalidModelResponse(`model returned an error: ${error.slice(0, 200)}`);
    }
    const content = raw.content;
    if (!Array.isArray(content)) {
      throw new InvalidModelResponse("response.content must be an array");
    }

    const blocks: RawBlock[] = [];
    const texts: string[] = [];
    const toolCalls: ToolCall[] = [];

    for (const entry of content) {
      if (!isObject(entry)) {
        throw new InvalidModelResponse("content block must be an object");
      }
      blocks.push(entry);
      const type = entry.type;
      if (type === "text") {
        if (typeof entry.text !== "string") {
          throw new InvalidModelResponse("text block must carry a string");
        }
        texts.push(entry.text);
      } else if (type === "tool_use") {
        if (typeof entry.id !== "string" || typeof entry.name !== "string") {
          throw new InvalidModelResponse("tool_use block must carry id and name");
        }
        toolCalls.push(
          createToolCall({
            id: entry.id,
            name: entry.name,
            arguments: isObject(entry.input) ? entry.input : {},
          }),
        );
      }
      // thinking / redacted_thinking 等块:只缓存,不投射到 ModelResponse。
    }

    // 缓存本轮原始块,供后续轮次原样回传。
    const turns = this.assistantTurns.get(nodeId) ?? [];
    turns.push(blocks);
    this.assistantTurns.set(nodeId, turns);

    const usage = isObject(raw.usage) ? raw.usage : {};
    const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : 0;
    const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : 0;

    return createModelResponse({
      // 无文本块时返回 null:AgentNode 据此判断"还在调工具"而非"已给出终答"。
      content: texts.length > 0 ? texts.join("") : null,
      toolCalls,
      usage: createUsage({
        inputTokens: Math.max(0, Math.trunc(inputTokens)),
        outputTokens: Math.max(0, Math.trunc(outputTokens)),
      }),
      finishReason: typeof raw.stop_reason === "string" ? raw.stop_reason : null,
    });
  }
}
