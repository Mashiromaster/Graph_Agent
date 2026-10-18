/**
 * Provider registry for OpenAI-compatible chat endpoints.
 *
 * Every provider below speaks the OpenAI `/chat/completions` protocol, so the
 * only per-provider facts worth recording are the base URL, the conventional
 * API-key env var, and a few model ids for the UI to suggest. The actual HTTP
 * work is delegated to OpenAICompatibleModel — this module adds no transport.
 *
 * Model ids are deliberately NOT an allowlist. Upstream ids churn fast (Kimi
 * moved K2 → K3, GLM to the 5.x line, Ark ids carry dated suffixes) and Ark
 * additionally accepts self-provisioned `ep-*` inference endpoint ids. A closed
 * list would reject valid models and force a release every time a vendor ships.
 * `suggestedModels` is therefore a UI hint only; admission is a format check.
 */

import type { ModelAdapter } from "./model.js";
import { OpenAICompatibleModel } from "./openai-compatible.js";
import type { JSONTransport } from "./transport.js";

const MODEL_ID_MAX = 128;
// Covers `qwen-plus`, `glm-4.6`, `deepseek-v4-flash`, `ep-20250101-abcde`, and
// dated snapshots. Excludes whitespace and path/query characters so a model id
// can never alter the request URL it is interpolated into.
const MODEL_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

export interface ProviderSpec {
  readonly type: string;
  /** Human-facing name for the UI picker. */
  readonly label: string;
  /** Default endpoint; null means the caller must supply one (self-hosted). */
  readonly baseUrl: string | null;
  /** Conventional env var consulted when no key is passed explicitly. */
  readonly apiKeyEnv: string | null;
  /** UI suggestions only — never an admission allowlist. See file header. */
  readonly suggestedModels: readonly string[];
  readonly requiresApiKey: boolean;
}

function spec(input: ProviderSpec): ProviderSpec {
  return Object.freeze({
    ...input,
    suggestedModels: Object.freeze([...input.suggestedModels]),
  });
}

export const PROVIDERS: Readonly<Record<string, ProviderSpec>> = Object.freeze({
  deepseek: spec({
    type: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    suggestedModels: ["deepseek-v4-flash", "deepseek-v4-pro"],
    requiresApiKey: true,
  }),
  qwen: spec({
    type: "qwen",
    label: "通义千问 Qwen",
    // Aliyun Model Studio (Beijing). Keys are region-scoped: a Beijing key will
    // not authenticate against the Singapore `dashscope-intl` host.
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    suggestedModels: ["qwen-max", "qwen-plus", "qwen-turbo", "qwen3-max"],
    requiresApiKey: true,
  }),
  glm: spec({
    type: "glm",
    label: "智谱 GLM",
    // Mainland endpoint. The international Z.ai host issues separate keys.
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    apiKeyEnv: "ZHIPU_API_KEY",
    suggestedModels: ["glm-4.6", "glm-4-plus"],
    requiresApiKey: true,
  }),
  kimi: spec({
    type: "kimi",
    label: "月之暗面 Kimi",
    baseUrl: "https://api.moonshot.cn/v1",
    apiKeyEnv: "MOONSHOT_API_KEY",
    suggestedModels: ["kimi-k2-turbo-preview", "moonshot-v1-128k"],
    requiresApiKey: true,
  }),
  doubao: spec({
    type: "doubao",
    label: "字节豆包 Doubao",
    // Volcengine Ark. `model` accepts either a published model id or an `ep-*`
    // inference endpoint id provisioned in the Ark console.
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    apiKeyEnv: "ARK_API_KEY",
    suggestedModels: ["doubao-seed-2.0-pro", "doubao-seed-2.0-lite"],
    requiresApiKey: true,
  }),
  openai: spec({
    type: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    suggestedModels: ["gpt-4o", "gpt-4o-mini"],
    requiresApiKey: true,
  }),
  anthropic: spec({
    type: "anthropic",
    label: "Anthropic Claude",
    // Anthropic's OpenAI-compatibility shim. It SILENTLY IGNORES unsupported
    // fields (logprobs, seed, n, presence/frequency_penalty) rather than
    // erroring, and clamps temperature to 0..1 instead of OpenAI's 0..2.
    // Extended thinking, prompt caching, and citations are reachable only via
    // the native /v1/messages API. Good enough for chat; not a full port.
    baseUrl: "https://api.anthropic.com/v1",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    suggestedModels: ["claude-sonnet-4-5", "claude-opus-4-8", "claude-haiku-4-5"],
    requiresApiKey: true,
  }),
  local: spec({
    type: "local",
    label: "本地推理 (Ollama / vLLM)",
    // No default: the caller must pass base_url. OpenAICompatibleModel permits
    // plain http for loopback hosts, which is what local runtimes serve on.
    baseUrl: null,
    apiKeyEnv: null,
    suggestedModels: ["qwen3:8b", "llama3.1:8b"],
    requiresApiKey: false,
  }),
});

/** Look up a provider by type, or null when unknown. */
export function providerSpec(type: string): ProviderSpec | null {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, type)
    ? (PROVIDERS[type] as ProviderSpec)
    : null;
}

/** Supported provider types, in registry order. */
export function providerTypes(): readonly string[] {
  return Object.freeze(Object.keys(PROVIDERS));
}

/**
 * Validate a model id by format rather than against a fixed list, and return
 * it trimmed. Error messages use the wire-facing `provider.model` prefix
 * because they are echoed back to HTTP clients.
 */
export function assertModelId(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("provider.model must be a string");
  }
  const model = value.trim();
  if (model.length === 0) {
    throw new Error("provider.model must not be blank");
  }
  if (model.length > MODEL_ID_MAX) {
    throw new Error(`provider.model must be at most ${MODEL_ID_MAX} chars`);
  }
  if (!MODEL_ID_PATTERN.test(model)) {
    throw new Error(
      "provider.model must contain only letters, digits, dot, underscore, colon, or hyphen",
    );
  }
  return model;
}

/**
 * Build a ModelAdapter for a registered provider.
 *
 * `baseUrl` overrides the registry default and is required for providers that
 * have none (`local`). URL safety (https outside loopback, no query/fragment/
 * credentials) is enforced by OpenAICompatibleModel, not duplicated here.
 */
export function createProviderModel(input: {
  type: string;
  model: string;
  apiKey?: string;
  baseUrl?: string;
  maxOutputTokens?: number;
  timeoutSeconds?: number;
  transport?: JSONTransport;
}): ModelAdapter {
  const found = providerSpec(input.type);
  if (found === null) {
    throw new Error(
      `provider.type must be one of ${providerTypes().join(", ")}`,
    );
  }

  const baseUrl = input.baseUrl ?? found.baseUrl ?? undefined;
  if (baseUrl === undefined) {
    throw new Error(`provider.base_url is required for the ${found.type} provider`);
  }

  const apiKey =
    input.apiKey ??
    (found.apiKeyEnv !== null ? process.env[found.apiKeyEnv] : undefined);
  if (found.requiresApiKey && (apiKey === undefined || apiKey === "")) {
    throw new Error(`provider.api_key is required for the ${found.type} provider`);
  }

  return new OpenAICompatibleModel({
    model: assertModelId(input.model),
    baseUrl,
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(input.maxOutputTokens !== undefined
      ? { maxOutputTokens: input.maxOutputTokens }
      : {}),
    ...(input.timeoutSeconds !== undefined
      ? { timeoutSeconds: input.timeoutSeconds }
      : {}),
    ...(input.transport !== undefined ? { transport: input.transport } : {}),
  });
}
