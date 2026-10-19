/**
 * Graph Agent Studio orchestration entry point.
 *
 * Validates the provider config + conversation, builds a fixed root
 * orchestrator spec, drives the TS GraphController end-to-end, and assembles the
 * StudioResult UI contract (spec §六). Determinism: no Date.now / Math.random in
 * the tested path — the run id is derived, and timing is injectable via opts.clock.
 *
 * Providers come from the @graph-agent/adapter registry. DeepSeek keeps its
 * subprocess-isolated Harness runtime; every other provider runs through
 * AgentNode + an OpenAI-compatible ModelAdapter. Both satisfy NodeRunner, so the
 * controller is unaware of which path a node took.
 */

import {
  createAgentIdentity,
  createAgentInput,
  createContextPacket,
  createNodeBudget,
  type AgentInput,
  type AgentResult,
  type Usage,
} from "@graph-agent/core";
import {
  GraphController,
  createControllerPolicy,
  deriveControllerId,
  parseResumableCheckpoint,
  resumeController,
  runSnapshotToDict,
  verifyControllerEventChain,
  type ControllerEvent,
  type NodeFactory,
  type NodeRunner,
} from "@graph-agent/orchestrator";
import {
  agentSpecFromDict,
  createAgentSpec,
  type AgentSpec,
} from "@graph-agent/node";
import { type Storage } from "@graph-agent/session";
import { DeepSeekHarnessNode } from "@graph-agent/harness";
import {
  assertModelId,
  createProviderModel,
  providerSpec,
  providerTypes,
  validateBaseUrl,
} from "@graph-agent/adapter";
import { AgentNode } from "@graph-agent/node";

// ── constants ─────────────────────────────────────────────────────────────

/** The provider used when a payload omits nothing — kept for UI defaults. */
export const DEFAULT_PROVIDER_TYPE = "deepseek";

/** DeepSeek is the only provider with a subprocess-isolated Harness runtime. */
const HARNESS_PROVIDER_TYPE = "deepseek";

const API_KEY_MIN = 8;
const API_KEY_MAX = 1024;
const CONVERSATION_MAX_ITEMS = 40;
const CONVERSATION_ITEM_MAX = 8000;
const CONVERSATION_TOTAL_MAX = 32000;

/**
 * Orchestrator instructions.
 *
 * The delegation guidance is explicit for a reason: when the prompt merely said
 * "decide whether to answer directly or propose sub-agents", the model treated
 * proposals as speculative paperwork — it answered everything itself and
 * described its proposal as "pending approval", so multi-agent runs never
 * actually produced a graph. Two things fix that: stating that approved
 * children really execute and report back within the same run, and naming a
 * concrete split criterion instead of leaving "worth delegating" to taste.
 */
const ORCHESTRATOR_INSTRUCTIONS =
  "You are the orchestrator for a small agent graph. Analyze the task and " +
  "produce a concise, well-structured final answer for the user.\n" +
  "Delegation:\n" +
  "- Propose a sub-agent when the task has two or more parts that can be worked " +
  "independently, when it needs breadth you cannot cover well in one pass " +
  "(research, surveys, comparisons, audits), or when the user explicitly asks " +
  "for multiple agents.\n" +
  "- Approved proposals DO run in this same session and their findings come " +
  "back to you as context. A proposal is real work being delegated, not a " +
  "request for permission, so do not describe it as merely pending and do not " +
  "duplicate the child's work yourself.\n" +
  "- Give each child a self-contained objective and the instructions it needs; " +
  "it cannot see this conversation. Propose at most two, and split by subject " +
  "matter so their work does not overlap.\n" +
  "- Answer directly, with no proposal, when the task is self-contained and a " +
  "single pass covers it. Say so briefly rather than delegating for show.\n" +
  "- When children report back, synthesize their findings into one answer and " +
  "reconcile any disagreement instead of concatenating them.";

// ── ProviderConfig ──────────────────────────────────────────────────────────

const PROVIDER_REQUIRED_KEYS = ["model", "type"] as const;
/** `base_url` is optional and only meaningful for self-hosted endpoints. */
const PROVIDER_OPTIONAL_KEYS = ["api_key", "base_url"] as const;

export interface ConversationTurn {
  readonly role: "user" | "assistant";
  readonly content: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(obj: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(obj).sort();
  const want = [...expected].sort();
  return keys.length === want.length && want.every((k, i) => keys[i] === k);
}

/**
 * Require every key in `required` and permit only those plus `optional`.
 * Still fail-closed on unknown keys — we just no longer demand an exact set,
 * so optional fields like `base_url` can be omitted.
 */
function hasAllowedKeys(
  obj: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): boolean {
  const keys = Object.keys(obj);
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((k) => Object.prototype.hasOwnProperty.call(obj, k)) &&
    keys.every((k) => allowed.has(k))
  );
}

export class ProviderConfig {
  readonly type: string;
  readonly apiKey: string;
  readonly model: string;
  /** Explicit endpoint override; empty string means "use the registry default". */
  readonly baseUrl: string;

  private constructor(type: string, apiKey: string, model: string, baseUrl: string) {
    this.type = type;
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl;
    Object.freeze(this);
  }

  static fromPayload(obj: unknown): ProviderConfig {
    if (!isPlainObject(obj)) {
      throw new Error("provider must be an object");
    }
    if (!hasAllowedKeys(obj, PROVIDER_REQUIRED_KEYS, PROVIDER_OPTIONAL_KEYS)) {
      throw new Error(
        "provider must have keys {type, model} and may include {api_key, base_url}",
      );
    }
    const type = obj["type"];
    if (typeof type !== "string") {
      throw new Error("provider.type must be a string");
    }
    const spec = providerSpec(type);
    if (spec === null) {
      throw new Error(`provider.type must be one of ${providerTypes().join(", ")}`);
    }

    const rawApiKey = obj["api_key"];
    let apiKey = "";
    if (spec.requiresApiKey || rawApiKey !== undefined) {
      if (typeof rawApiKey !== "string") {
        throw new Error("provider.api_key must be a string");
      }
      if (rawApiKey.length < API_KEY_MIN || rawApiKey.length > API_KEY_MAX) {
        throw new Error(`provider.api_key length must be ${API_KEY_MIN}..${API_KEY_MAX}`);
      }
      if (rawApiKey !== rawApiKey.trim()) {
        throw new Error("provider.api_key must not have leading or trailing whitespace");
      }
      // Printable ASCII only (0x20..0x7E): rejects control chars and non-ASCII.
      if (!/^[\x20-\x7e]+$/.test(rawApiKey)) {
        throw new Error("provider.api_key must be printable ASCII");
      }
      apiKey = rawApiKey;
    }

    // Format check, not an allowlist: upstream model ids churn and Ark accepts
    // self-provisioned `ep-*` endpoint ids.
    const model = assertModelId(obj["model"]);

    const rawBaseUrl = obj["base_url"];
    let baseUrl = "";
    if (rawBaseUrl !== undefined) {
      if (typeof rawBaseUrl !== "string") {
        throw new Error("provider.base_url must be a string");
      }
      if (spec.baseUrl !== null) {
        throw new Error(`provider.base_url is not allowed for the ${type} provider`);
      }
      // Check the URL here so a bad endpoint is a 400 on the payload rather
      // than surfacing later as a generic run failure.
      try {
        validateBaseUrl(rawBaseUrl);
      } catch (error) {
        throw new Error(
          `provider.base_url is invalid: ${error instanceof Error ? error.message : "bad URL"}`,
        );
      }
      baseUrl = rawBaseUrl;
    } else if (spec.baseUrl === null) {
      throw new Error(`provider.base_url is required for the ${type} provider`);
    }

    return new ProviderConfig(type, apiKey, model, baseUrl);
  }
}

/** @deprecated Use {@link ProviderConfig}; retained for the original API name. */
export const DeepSeekConfig = ProviderConfig;
export type DeepSeekConfig = ProviderConfig;

// ── parseConversation ─────────────────────────────────────────────────────

const TURN_KEYS = ["content", "role"] as const;

export function parseConversation(value: unknown): ConversationTurn[] {
  if (!Array.isArray(value)) {
    throw new Error("conversation must be an array");
  }
  if (value.length > CONVERSATION_MAX_ITEMS) {
    throw new Error(`conversation must have at most ${CONVERSATION_MAX_ITEMS} turns`);
  }
  if (value.length % 2 !== 0) {
    throw new Error("conversation must alternate user/assistant and end with assistant");
  }
  const turns: ConversationTurn[] = [];
  let totalChars = 0;
  for (let i = 0; i < value.length; i += 1) {
    const item = value[i];
    if (!isPlainObject(item)) {
      throw new Error(`conversation[${i}] must be an object`);
    }
    if (!hasExactKeys(item, TURN_KEYS)) {
      throw new Error(`conversation[${i}] must have exactly keys {role, content}`);
    }
    const role = item["role"];
    const content = item["content"];
    if (role !== "user" && role !== "assistant") {
      throw new Error(`conversation[${i}].role must be "user" or "assistant"`);
    }
    const expected = i % 2 === 0 ? "user" : "assistant";
    if (role !== expected) {
      throw new Error("conversation must alternate starting with user and ending with assistant");
    }
    if (typeof content !== "string") {
      throw new Error(`conversation[${i}].content must be a string`);
    }
    if (content.length > CONVERSATION_ITEM_MAX) {
      throw new Error(`conversation[${i}].content must be at most ${CONVERSATION_ITEM_MAX} chars`);
    }
    if (content.trim().length === 0) {
      throw new Error(`conversation[${i}].content must not be blank`);
    }
    totalChars += content.length;
    turns.push({ role, content });
  }
  if (totalChars > CONVERSATION_TOTAL_MAX) {
    throw new Error(`conversation total content must be at most ${CONVERSATION_TOTAL_MAX} chars`);
  }
  return turns;
}

function renderConversation(turns: readonly ConversationTurn[]): string {
  return turns.map((t) => `${t.role}: ${t.content}`).join("\n");
}

// ── StudioResult ────────────────────────────────────────────────────────────

export interface StudioNodeResult {
  readonly node_id: string;
  readonly status: string;
  readonly output: string | null;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
  readonly error: { readonly code: string; readonly message: string } | null;
}

export interface StudioResult {
  readonly controller_event_chain_valid: boolean;
  readonly elapsed_ms: number;
  readonly event_count: number;
  readonly events: readonly { readonly hash: string; readonly sequence: number; readonly type: string }[];
  readonly live: boolean;
  readonly node_results: readonly StudioNodeResult[];
  readonly primary_output: string | null;
  readonly provider: {
    readonly endpoint: string;
    readonly model: string;
    readonly thinking: string;
    readonly type: string;
  };
  readonly snapshot: Record<string, unknown>;
  readonly task: string;
  readonly checkpoint: string;
}

/**
 * Wraps a NodeRunner so each node's result summary is captured into a shared
 * map keyed by nodeId. The controller drives run(); we record the outcome.
 */
class RecordedRunner implements NodeRunner {
  readonly spec: AgentSpec;
  private readonly inner: NodeRunner;
  private readonly sink: Map<string, StudioNodeResult>;

  constructor(inner: NodeRunner, sink: Map<string, StudioNodeResult>) {
    this.spec = inner.spec as AgentSpec;
    this.inner = inner;
    this.sink = sink;
  }

  async run(input: AgentInput, signal?: AbortSignal): Promise<AgentResult> {
    const result = await this.inner.run(input, signal);
    const usage: Usage = result.usage;
    this.sink.set(result.nodeId, {
      node_id: result.nodeId,
      status: result.status,
      output: result.output,
      usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
      error: result.error === null ? null : { code: result.error.code, message: result.error.message },
    });
    return result;
  }
}

/**
 * Build the runner factory for a provider.
 *
 * DeepSeek keeps the Harness path (subprocess isolation + a fail-closed
 * capability patch, which is why it refuses local tools). Every other provider
 * runs AgentNode over an OpenAI-compatible adapter; AgentNode already exposes
 * the graph proposal tools, so governance is identical either way.
 */
export function providerFactory(
  provider: ProviderConfig,
  clock?: () => number,
): NodeFactory {
  return {
    create({ spec, toolNames }) {
      if (provider.type === HARNESS_PROVIDER_TYPE && toolNames.length > 0) {
        throw new Error("The DeepSeek Harness runtime does not expose local tools");
      }
      const expanded = spec as Partial<AgentSpec>;
      const harnessSpec =
        typeof expanded.instructions === "string" && expanded.policy !== undefined
          ? (spec as AgentSpec)
          : createAgentSpec({
              identity: spec.identity,
              budget: spec.budget,
              role: spec.role ?? spec.identity.role,
              instructions:
                `You are a focused ${spec.role ?? spec.identity.role} sub-agent. ` +
                "Complete the delegated objective and report concrete, specific " +
                "findings — your output is read by the orchestrator, not the end " +
                "user, so lead with substance and skip preamble about your own " +
                "role or process. Stay inside your objective; the orchestrator " +
                "handles the rest of the task. Propose a child of your own only " +
                "when your objective genuinely splits further, which is rare.",
              policy: {
                maxGeneration: 2,
                maxChildren: 2,
                allowDirectMessages: false,
                allowSkipContext: false,
              },
            });
      if (provider.type === HARNESS_PROVIDER_TYPE) {
        return new DeepSeekHarnessNode({
          spec: harnessSpec,
          apiKey: provider.apiKey,
          model: provider.model,
          availableToolNames: toolNames,
          ...(clock !== undefined ? { clock } : {}),
        });
      }

      return new AgentNode({
        spec: harnessSpec,
        model: createProviderModel({
          type: provider.type,
          model: provider.model,
          ...(provider.apiKey !== "" ? { apiKey: provider.apiKey } : {}),
          ...(provider.baseUrl !== "" ? { baseUrl: provider.baseUrl } : {}),
          maxOutputTokens: harnessSpec.budget.maxTotalTokens,
          timeoutSeconds: harnessSpec.budget.timeoutSeconds,
        }),
        ...(clock !== undefined ? { clock } : {}),
      });
    },
  };
}

/** The endpoint and thinking mode reported back to the UI for a provider. */
function providerSummary(provider: ProviderConfig): {
  endpoint: string;
  model: string;
  thinking: string;
  type: string;
} {
  const spec = providerSpec(provider.type);
  return {
    endpoint: provider.baseUrl !== "" ? provider.baseUrl : (spec?.baseUrl ?? ""),
    model: provider.model,
    thinking: provider.type === HARNESS_PROVIDER_TYPE ? "harness-managed" : "none",
    type: provider.type,
  };
}

/** The fixed controller policy shared by fresh runs and resumed runs. */
function studioControllerPolicy(): ReturnType<typeof createControllerPolicy> {
  return createControllerPolicy({
    maxNodes: 5,
    maxEdges: 8,
    maxGeneration: 2,
    maxChildrenPerNode: 2,
    maxTotalTokens: 32000,
    maxConcurrency: 2,
    maxProposalsPerResult: 8,
  });
}

/**
 * Wraps a factory so every runner it produces (root + children) records its
 * result summary into the shared sink. This makes node_results capture work for
 * ANY underlying factory (a real provider one or an injected test factory).
 */
function recordingFactory(inner: NodeFactory, sink: Map<string, StudioNodeResult>): NodeFactory {
  return {
    create(args) {
      return new RecordedRunner(inner.create(args), sink);
    },
  };
}

export function runStudioGraph(
  input: { task: string; provider: ProviderConfig; conversation: readonly ConversationTurn[] },
  opts?: { factory?: NodeFactory; clock?: () => number; storage?: Storage },
): Promise<StudioResult> {
  return runStudioGraphImpl(input, opts);
}

async function runStudioGraphImpl(
  input: { task: string; provider: ProviderConfig; conversation: readonly ConversationTurn[] },
  opts?: { factory?: NodeFactory; clock?: () => number; storage?: Storage },
): Promise<StudioResult> {
  const { task, provider, conversation } = input;
  const clock = opts?.clock;

  const rootSpec = createAgentSpec({
    identity: createAgentIdentity({
      nodeId: "root",
      name: "Orchestrator",
      role: "orchestrator",
      generation: 0,
    }),
    instructions: ORCHESTRATOR_INSTRUCTIONS,
    role: "orchestrator",
    budget: createNodeBudget({
      maxTurns: 4,
      maxToolCalls: 4,
      maxTotalTokens: 12000,
      timeoutSeconds: 90,
    }),
    policy: {
      maxGeneration: 2,
      maxChildren: 2,
      allowDirectMessages: false,
      allowSkipContext: false,
    },
  });

  const runId = deriveControllerId("studio-run", task, conversation.length);
  const rootInput = createAgentInput({
    task,
    context:
      conversation.length > 0
        ? [
            createContextPacket({
              sourceNodeId: "conversation-history",
              content: renderConversation(conversation),
              trust: 0.9,
              edgeType: "conversation",
            }),
          ]
        : [],
    sessionId: runId,
  });

  const controllerPolicy = studioControllerPolicy();

  const nodeResults = new Map<string, StudioNodeResult>();
  const baseFactory = opts?.factory ?? providerFactory(provider, clock);
  const factory = recordingFactory(baseFactory, nodeResults);
  const rootRunner = factory.create({ spec: rootSpec, toolNames: [] });

  const startedAt = clock ? clock() : performance.now();
  const controller = new GraphController(factory, controllerPolicy, clock);
  await controller.createRun(runId, rootSpec, rootRunner, rootInput);
  const snapshot = await controller.runUntilIdle(runId);
  const events: readonly ControllerEvent[] = controller.events(runId);
  const checkpoint = await controller.checkpointResumable(runId);
  const elapsedMs = clock ? clock() - startedAt : performance.now() - startedAt;

  const rootResult = nodeResults.get("root");
  const nodeResultList = [...nodeResults.values()].sort((a, b) =>
    a.node_id < b.node_id ? -1 : a.node_id > b.node_id ? 1 : 0,
  );

  return {
    controller_event_chain_valid: verifyControllerEventChain(events),
    elapsed_ms: elapsedMs,
    event_count: events.length,
    events: events.map((e) => ({
      hash: e.eventHash.slice(0, 12),
      sequence: e.sequence,
      type: e.type,
    })),
    live: true,
    node_results: nodeResultList,
    primary_output: rootResult ? rootResult.output : null,
    provider: providerSummary(provider),
    snapshot: runSnapshotToDict(snapshot),
    task,
    checkpoint,
  };
}

/**
 * Resume a run from a v2 resumable checkpoint. Builds a Harness-backed factory
 * (or an injected test factory), rehydrates the controller via the
 * orchestrator's resumeController (bridging the opaque spec back to a node
 * AgentSpec through agentSpecFromDict), drives it to idle, and assembles the
 * SAME StudioResult shape as runStudioGraph — including a fresh checkpoint.
 */
export async function runResume(
  checkpointJson: string,
  provider: ProviderConfig,
  opts?: { storage?: Storage; clock?: () => number; factory?: NodeFactory },
): Promise<StudioResult> {
  const clock = opts?.clock;
  const baseFactory = opts?.factory ?? providerFactory(provider, clock);

  const nodeResults = new Map<string, StudioNodeResult>();
  const factory = recordingFactory(baseFactory, nodeResults);

  const parsed = parseResumableCheckpoint(checkpointJson);
  const runId = parsed.finalSnapshot.runId;

  const controller = resumeController(checkpointJson, factory, {
    policy: studioControllerPolicy(),
    ...(clock !== undefined ? { clock } : {}),
    rehydrateSpec: agentSpecFromDict,
  });

  const startedAt = clock ? clock() : performance.now();
  const snapshot = await controller.runUntilIdle(runId);
  const events: readonly ControllerEvent[] = controller.events(runId);
  const checkpoint = await controller.checkpointResumable(runId);
  const elapsedMs = clock ? clock() - startedAt : performance.now() - startedAt;

  const rootResult = nodeResults.get("root");
  const nodeResultList = [...nodeResults.values()].sort((a, b) =>
    a.node_id < b.node_id ? -1 : a.node_id > b.node_id ? 1 : 0,
  );

  return {
    controller_event_chain_valid: verifyControllerEventChain(events),
    elapsed_ms: elapsedMs,
    event_count: events.length,
    events: events.map((e) => ({
      hash: e.eventHash.slice(0, 12),
      sequence: e.sequence,
      type: e.type,
    })),
    live: true,
    node_results: nodeResultList,
    primary_output: rootResult ? rootResult.output : null,
    provider: providerSummary(provider),
    snapshot: runSnapshotToDict(snapshot),
    task: "resume",
    checkpoint,
  };
}
