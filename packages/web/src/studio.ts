/**
 * Graph Agent Studio orchestration entry point.
 *
 * Validates the DeepSeek provider config + conversation, builds a fixed root
 * orchestrator spec, drives the TS GraphController end-to-end, and assembles the
 * StudioResult UI contract (spec §六). Determinism: no Date.now / Math.random in
 * the tested path — the run id is derived, and timing is injectable via opts.clock.
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
  runSnapshotToDict,
  verifyControllerEventChain,
  type ControllerEvent,
  type NodeFactory,
  type NodeRunner,
} from "@graph-agent/orchestrator";
import { AgentNode, createAgentSpec, type AgentSpec } from "@graph-agent/node";
import { OpenAICompatibleModel } from "@graph-agent/adapter";

// ── constants ─────────────────────────────────────────────────────────────

const DEEPSEEK_MODELS = Object.freeze(["deepseek-v4-flash", "deepseek-v4-pro"] as const);
export type DeepSeekModel = (typeof DEEPSEEK_MODELS)[number];

const DEEPSEEK_ENDPOINT = "https://api.deepseek.com";
const API_KEY_MIN = 8;
const API_KEY_MAX = 1024;
const CONVERSATION_MAX_ITEMS = 40;
const CONVERSATION_ITEM_MAX = 8000;
const CONVERSATION_TOTAL_MAX = 32000;

const ORCHESTRATOR_INSTRUCTIONS =
  "You are the orchestrator for a small agent graph. Analyze the task, decide " +
  "whether to answer directly or to propose at most two focused sub-agents, and " +
  "produce a concise, well-structured final answer for the user.";

// ── DeepSeekConfig ──────────────────────────────────────────────────────────

const PROVIDER_KEYS = ["api_key", "model", "type"] as const;

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

export class DeepSeekConfig {
  readonly type: "deepseek";
  readonly apiKey: string;
  readonly model: DeepSeekModel;

  private constructor(apiKey: string, model: DeepSeekModel) {
    this.type = "deepseek";
    this.apiKey = apiKey;
    this.model = model;
    Object.freeze(this);
  }

  static fromPayload(obj: unknown): DeepSeekConfig {
    if (!isPlainObject(obj)) {
      throw new Error("provider must be an object");
    }
    if (!hasExactKeys(obj, PROVIDER_KEYS)) {
      throw new Error("provider must have exactly keys {type, api_key, model}");
    }
    if (obj["type"] !== "deepseek") {
      throw new Error('provider.type must be "deepseek"');
    }
    const apiKey = obj["api_key"];
    if (typeof apiKey !== "string") {
      throw new Error("provider.api_key must be a string");
    }
    if (apiKey.length < API_KEY_MIN || apiKey.length > API_KEY_MAX) {
      throw new Error(`provider.api_key length must be ${API_KEY_MIN}..${API_KEY_MAX}`);
    }
    if (apiKey !== apiKey.trim()) {
      throw new Error("provider.api_key must not have leading or trailing whitespace");
    }
    // Printable ASCII only (0x20..0x7E): rejects control chars and non-ASCII.
    if (!/^[\x20-\x7e]+$/.test(apiKey)) {
      throw new Error("provider.api_key must be printable ASCII");
    }
    const model = obj["model"];
    if (typeof model !== "string" || !(DEEPSEEK_MODELS as readonly string[]).includes(model)) {
      throw new Error(`provider.model must be one of ${DEEPSEEK_MODELS.join(", ")}`);
    }
    return new DeepSeekConfig(apiKey, model as DeepSeekModel);
  }
}

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

function deepSeekFactory(provider: DeepSeekConfig): NodeFactory {
  return {
    create({ spec, toolNames }) {
      if (toolNames.length > 0) {
        throw new Error("DeepSeek Studio does not expose local tools");
      }
      const model = new OpenAICompatibleModel({
        model: provider.model,
        apiKey: provider.apiKey,
        baseUrl: DEEPSEEK_ENDPOINT,
        timeoutSeconds: 90,
        maxOutputTokens: 2048,
        extraBody: { thinking: { type: "disabled" } },
      });
      return new AgentNode({ spec: spec as AgentSpec, model });
    },
  };
}

/**
 * Wraps a factory so every runner it produces (root + children) records its
 * result summary into the shared sink. This makes node_results capture work for
 * ANY underlying factory (the real DeepSeek one or an injected test factory).
 */
function recordingFactory(inner: NodeFactory, sink: Map<string, StudioNodeResult>): NodeFactory {
  return {
    create(args) {
      return new RecordedRunner(inner.create(args), sink);
    },
  };
}

export function runStudioGraph(
  input: { task: string; provider: DeepSeekConfig; conversation: readonly ConversationTurn[] },
  opts?: { factory?: NodeFactory; clock?: () => number },
): Promise<StudioResult> {
  return runStudioGraphImpl(input, opts);
}

async function runStudioGraphImpl(
  input: { task: string; provider: DeepSeekConfig; conversation: readonly ConversationTurn[] },
  opts?: { factory?: NodeFactory; clock?: () => number },
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

  const controllerPolicy = createControllerPolicy({
    maxNodes: 5,
    maxEdges: 8,
    maxGeneration: 2,
    maxChildrenPerNode: 2,
    maxTotalTokens: 32000,
    maxConcurrency: 2,
    maxProposalsPerResult: 8,
  });

  const nodeResults = new Map<string, StudioNodeResult>();
  const baseFactory = opts?.factory ?? deepSeekFactory(provider);
  const factory = recordingFactory(baseFactory, nodeResults);
  const rootRunner = factory.create({ spec: rootSpec, toolNames: [] });

  const startedAt = clock ? clock() : performance.now();
  const controller = new GraphController(factory, controllerPolicy, clock);
  await controller.createRun(runId, rootSpec, rootRunner, rootInput);
  const snapshot = await controller.runUntilIdle(runId);
  const events: readonly ControllerEvent[] = controller.events(runId);
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
    provider: {
      endpoint: DEEPSEEK_ENDPOINT,
      model: provider.model,
      thinking: "disabled",
      type: "deepseek",
    },
    snapshot: runSnapshotToDict(snapshot),
    task,
  };
}
