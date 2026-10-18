import { assertFinitePositive, canonicalJson, createUsage } from "@graph-agent/core";
import type { Message, ModelRequest, ModelResponse, ToolCall } from "./model-types.js";
import { createModelResponse, createToolCall } from "./model-types.js";
import type { ModelAdapter } from "./model.js";
import { FetchJSONTransport, InvalidModelResponse } from "./transport.js";
import type { JSONTransport } from "./transport.js";

export { InvalidModelResponse } from "./transport.js";

const RESERVED_KEYS = new Set(["model", "messages", "tools", "tool_choice", "max_tokens"]);
const MAX_EXTRA_BODY_BYTES = 16384;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * Validate an endpoint URL: http(s) only, https required outside loopback, and
 * no query, fragment, or embedded credentials. Exported so callers can surface
 * a precise error at input-validation time instead of at adapter construction.
 */
export function validateBaseUrl(baseUrl: string): URL {
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
  const isLoopback = LOOPBACK_HOSTS.has(url.hostname);
  if (!isLoopback && url.protocol !== "https:") {
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

function validateExtraBody(extraBody: Readonly<Record<string, unknown>>): void {
  if (extraBody === null || typeof extraBody !== "object" || Array.isArray(extraBody)) {
    throw new TypeError("extraBody must be a plain object");
  }
  for (const key of Object.keys(extraBody)) {
    if (typeof key !== "string") {
      throw new TypeError("extraBody keys must be strings");
    }
    if (RESERVED_KEYS.has(key)) {
      throw new Error(`extraBody must not contain the reserved key "${key}"`);
    }
  }
  let serialized: string;
  try {
    serialized = canonicalJson(extraBody);
  } catch {
    throw new Error("extraBody is not serializable");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_EXTRA_BODY_BYTES) {
    throw new RangeError("extraBody exceeds the maximum serialized size");
  }
}

function messagePayload(message: Message): Record<string, unknown> {
  if (message.role === "context") {
    return { role: "user", content: message.content };
  }
  const base: Record<string, unknown> = { role: message.role, content: message.content };
  if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
    base.tool_calls = message.toolCalls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: canonicalJson(tc.arguments) },
    }));
  }
  if (message.role === "tool") {
    if (!message.toolCallId) {
      throw new Error("tool message requires toolCallId");
    }
    base.tool_call_id = message.toolCallId;
  } else if (message.name !== undefined) {
    base.name = message.name;
  }
  return base;
}

function coerceTokens(value: unknown): number {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n) || n < 0) {
    return 0;
  }
  return Math.trunc(n);
}

function textContent(content: unknown): string | null {
  if (content === null) {
    return null;
  }
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts = content
      .filter(
        (part): part is { type: string; text: string } =>
          part !== null &&
          typeof part === "object" &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string",
      )
      .map((part) => part.text);
    const joined = parts.join("");
    return joined === "" ? null : joined;
  }
  throw new InvalidModelResponse("Response message content has an unsupported shape");
}

function parseToolCalls(rawToolCalls: unknown): ToolCall[] {
  if (rawToolCalls === undefined || rawToolCalls === null) {
    return [];
  }
  if (!Array.isArray(rawToolCalls)) {
    throw new InvalidModelResponse("Malformed function tool call");
  }
  return rawToolCalls.map((tc) => {
    if (tc === null || typeof tc !== "object") {
      throw new InvalidModelResponse("Malformed function tool call");
    }
    const entry = tc as { id?: unknown; type?: unknown; function?: unknown };
    if (entry.type !== "function") {
      throw new InvalidModelResponse("Malformed function tool call");
    }
    const fn = entry.function;
    if (fn === null || typeof fn !== "object") {
      throw new InvalidModelResponse("Malformed function tool call");
    }
    const fnObj = fn as { name?: unknown; arguments?: unknown };
    if (
      typeof entry.id !== "string" ||
      typeof fnObj.name !== "string" ||
      typeof fnObj.arguments !== "string"
    ) {
      throw new InvalidModelResponse("Malformed function tool call");
    }
    let parsedArgs: unknown;
    try {
      parsedArgs = JSON.parse(fnObj.arguments === "" ? "{}" : fnObj.arguments);
    } catch {
      throw new InvalidModelResponse("Malformed function tool call");
    }
    if (parsedArgs === null || typeof parsedArgs !== "object" || Array.isArray(parsedArgs)) {
      throw new InvalidModelResponse("Malformed function tool call");
    }
    return createToolCall({
      id: entry.id,
      name: fnObj.name,
      arguments: parsedArgs as Record<string, unknown>,
    });
  });
}

function parseResponse(raw: unknown): ModelResponse {
  const root = raw as { choices?: unknown; usage?: unknown };
  const choices = root.choices;
  const firstChoice = Array.isArray(choices) ? choices[0] : undefined;
  const message =
    firstChoice !== null && typeof firstChoice === "object"
      ? (firstChoice as { message?: unknown }).message
      : undefined;
  if (message === null || typeof message !== "object") {
    throw new InvalidModelResponse("Response has no completion choice");
  }
  const messageObj = message as { content?: unknown; tool_calls?: unknown };
  const toolCalls = parseToolCalls(messageObj.tool_calls);
  const content = textContent(messageObj.content ?? null);
  const usageRaw = root.usage as { prompt_tokens?: unknown; completion_tokens?: unknown } | undefined;
  const usage = createUsage({
    inputTokens: coerceTokens(usageRaw?.prompt_tokens),
    outputTokens: coerceTokens(usageRaw?.completion_tokens),
  });
  const finishReasonRaw = (firstChoice as { finish_reason?: unknown }).finish_reason;
  const finishReason =
    finishReasonRaw !== undefined && finishReasonRaw !== null ? String(finishReasonRaw) : null;
  return createModelResponse({ content, toolCalls, usage, finishReason });
}

export class OpenAICompatibleModel implements ModelAdapter {
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly timeoutSeconds: number;
  private readonly maxOutputTokens: number | undefined;
  private readonly extraBody: Readonly<Record<string, unknown>>;
  private readonly transport: JSONTransport;

  constructor(config: {
    model: string;
    apiKey?: string;
    baseUrl?: string;
    timeoutSeconds?: number;
    maxOutputTokens?: number;
    extraBody?: Readonly<Record<string, unknown>>;
    transport?: JSONTransport;
  }) {
    const model = config.model?.trim();
    if (!model) {
      throw new Error("model must be a non-empty string");
    }
    this.model = model;

    const rawBaseUrl = (config.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    const parsedUrl = validateBaseUrl(rawBaseUrl);
    this.baseUrl = rawBaseUrl;

    const timeoutSeconds = assertFinitePositive(config.timeoutSeconds ?? 60, "timeoutSeconds");
    this.timeoutSeconds = timeoutSeconds;

    if (config.maxOutputTokens !== undefined) {
      if (!Number.isInteger(config.maxOutputTokens) || config.maxOutputTokens < 1) {
        throw new RangeError("maxOutputTokens must be an integer >= 1");
      }
    }
    this.maxOutputTokens = config.maxOutputTokens;

    const extraBody = config.extraBody ?? {};
    validateExtraBody(extraBody);
    this.extraBody = extraBody;

    let apiKey = config.apiKey;
    if (apiKey === undefined && parsedUrl.hostname === "api.openai.com") {
      apiKey = process.env.OPENAI_API_KEY;
    }
    this.apiKey = apiKey;

    this.transport = config.transport ?? new FetchJSONTransport();
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const messages: Array<Record<string, unknown>> = [
      { role: "system", content: request.instructions },
    ];
    for (const message of request.messages) {
      messages.push(messagePayload(message));
    }

    const body: Record<string, unknown> = { model: this.model, messages, ...this.extraBody };
    if (request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));
    }
    if (this.maxOutputTokens !== undefined) {
      body.max_tokens = this.maxOutputTokens;
    }

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    const raw = await this.transport.postJson({
      url: `${this.baseUrl}/chat/completions`,
      headers,
      payload: body,
      timeoutSeconds: this.timeoutSeconds,
    });

    return parseResponse(raw);
  }
}
