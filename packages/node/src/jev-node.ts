/**
 * JevNode — a decision node backed by TypeSafe System One (Jev).
 *
 * Jev does not generate text, so this node is shaped differently from AgentNode:
 *
 * - **No tool loop, no turns.** One request, one set of answers. There is
 *   nothing for the model to iterate on, so budget.maxTurns / maxToolCalls are
 *   not consumed; only tokens and the timeout apply.
 * - **No proposals.** Jev cannot ask for children, messages, or skipped
 *   context — it only answers the questions it was given. Every proposal list
 *   comes back empty, which is why the node needs no ProposalCollector.
 * - **Questions come from the spec**, not from the model or from untrusted
 *   context. The host (or a parent's approved spawn) fixes what gets decided;
 *   the node only supplies the state. This keeps a resumed run asking exactly
 *   the same questions.
 *
 * `output` is the canonical-JSON serialization of the answers, so downstream
 * nodes can read it as context and the existing result-hash / event-chain
 * machinery works unchanged — no core contract was widened for this.
 */

import {
  EventRecorder,
  EventType,
  NodeStatus,
  canonicalJson,
  createAgentResult,
  createNodeError,
  createUsage,
  resultBindingHash,
  usageTotalTokens,
  type AgentInput,
  type AgentResult,
  type Usage,
} from "@graph-agent/core";
import type { JevDecision, JevQuestion } from "@graph-agent/adapter";
import type { AgentSpec } from "./spec.js";
import type { NodeRunner } from "./agent-node.js";

/** The subset of JevDecisionClient this node needs; keeps tests transport-free. */
export interface JevDecider {
  decide(input: {
    state: string | Readonly<Record<string, unknown>>;
    questions: Readonly<Record<string, JevQuestion>>;
  }): Promise<JevDecision>;
}

export interface JevNodeOptions {
  readonly spec: AgentSpec;
  /** What to decide. Fixed by the host, never taken from model output. */
  readonly questions: Readonly<Record<string, JevQuestion>>;
  readonly client: JevDecider;
  readonly clock?: () => number;
}

/**
 * Serialize answers deterministically for `output`.
 *
 * Probability and confidence stay separate fields — collapsing them would
 * destroy the distinction upstream warns about.
 */
function serializeAnswers(decision: JevDecision): string {
  const answers: Record<string, unknown> = {};
  for (const id of Object.keys(decision.answers).sort()) {
    const answer = decision.answers[id]!;
    answers[id] = {
      type: answer.type,
      ...(answer.choice !== null ? { choice: answer.choice } : {}),
      ...(answer.noul !== null ? { noul: answer.noul } : {}),
      ...(answer.score !== null ? { score: answer.score } : {}),
      probabilities: answer.probabilities,
      ...(answer.confidence !== null ? { confidence: answer.confidence } : {}),
      ...(answer.legend !== null ? { legend: answer.legend } : {}),
    };
  }
  return canonicalJson({ model: decision.model, answers });
}

/**
 * Build the state Jev evaluates: the task plus any cross-node context.
 *
 * Structured rather than flattened to a string — Jev reasons over fields, and
 * the context stays clearly labelled as untrusted evidence.
 */
function buildState(input: AgentInput): Record<string, unknown> {
  return {
    task: input.task,
    context: input.context.map((packet) => ({
      source_node_id: packet.sourceNodeId,
      edge_type: packet.edgeType,
      trust: packet.trust,
      content: packet.content,
    })),
  };
}

export class JevNode implements NodeRunner {
  readonly spec: AgentSpec;
  private readonly questions: Readonly<Record<string, JevQuestion>>;
  private readonly client: JevDecider;
  private readonly clock: () => number;

  constructor(options: JevNodeOptions) {
    this.spec = options.spec;
    this.questions = options.questions;
    this.client = options.client;
    this.clock = options.clock ?? (() => Date.now());
  }

  async run(input: AgentInput, signal?: AbortSignal): Promise<AgentResult> {
    const nodeId = this.spec.identity.nodeId;
    const recorder = new EventRecorder(nodeId, this.clock);

    recorder.record({
      type: EventType.NODE_STARTED,
      inputValue: input.task,
      metadata: {
        generation: this.spec.identity.generation,
        runtime: "jev",
        question_count: Object.keys(this.questions).length,
      },
    });

    if (signal?.aborted) {
      return this.failure(recorder, createUsage(), "execution_error", "The node was cancelled.", true);
    }

    recorder.record({
      type: EventType.MODEL_STARTED,
      inputValue: input.context.map((packet) => packet.content),
      metadata: { runtime: "jev" },
    });

    let decision: JevDecision;
    try {
      decision = await this.withGuards(input, signal);
    } catch (error) {
      // Distinguish our own sentinels from upstream transport failures, and
      // never surface raw upstream error text (it can echo request content).
      const stop = classifyError(error);
      return this.failure(recorder, createUsage(), stop.code, stop.message, stop.retryable);
    }

    const usage = createUsage({
      inputTokens: decision.inputTokens,
      outputTokens: decision.outputTokens,
    });
    const output = serializeAnswers(decision);

    recorder.record({
      type: EventType.MODEL_COMPLETED,
      outputValue: output,
      metadata: {
        runtime: "jev",
        model: decision.model,
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
      },
    });

    // Jev has no turns or tool calls, so tokens are the only budget to enforce.
    if (usageTotalTokens(usage) > this.spec.budget.maxTotalTokens) {
      return this.failure(
        recorder,
        usage,
        "token_budget_exceeded",
        "The node exceeded its token budget.",
        false,
      );
    }

    const resultHash = resultBindingHash({
      nodeId,
      status: NodeStatus.COMPLETED,
      output,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      spawnProposals: [],
      messageProposals: [],
      skipContextProposals: [],
    });
    recorder.record({
      type: EventType.NODE_COMPLETED,
      outputValue: output,
      metadata: { result_hash: resultHash, runtime: "jev" },
    });

    return createAgentResult({
      nodeId,
      status: NodeStatus.COMPLETED,
      output,
      usage,
      events: recorder.events,
      error: null,
    });
  }

  /** Race the request against cancellation and the node's time budget. */
  private async withGuards(input: AgentInput, signal?: AbortSignal): Promise<JevDecision> {
    let rejectStop: ((error: Error) => void) | undefined;
    let stopped = false;
    const stopPromise = new Promise<never>((_resolve, reject) => {
      rejectStop = reject;
    });
    const stop = (error: Error): void => {
      if (stopped) return;
      stopped = true;
      rejectStop?.(error);
    };

    const onAbort = (): void => stop(new NodeCancelled());
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(
      () => stop(new NodeTimeout()),
      this.spec.budget.timeoutSeconds * 1000,
    );

    try {
      return await Promise.race([
        this.client.decide({ state: buildState(input), questions: this.questions }),
        stopPromise,
      ]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private failure(
    recorder: EventRecorder,
    usage: Usage,
    code: string,
    message: string,
    retryable: boolean,
  ): AgentResult {
    const nodeId = this.spec.identity.nodeId;
    const error = createNodeError({ code, message, retryable });
    const resultHash = resultBindingHash({
      nodeId,
      status: NodeStatus.FAILED,
      output: null,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      spawnProposals: [],
      messageProposals: [],
      skipContextProposals: [],
      error,
    });
    recorder.record({
      type: code.includes("budget") ? EventType.BUDGET_EXCEEDED : EventType.NODE_FAILED,
      outputValue: message,
      metadata: { code, retryable, result_hash: resultHash, runtime: "jev" },
    });
    return createAgentResult({
      nodeId,
      status: NodeStatus.FAILED,
      output: null,
      usage,
      events: recorder.events,
      error,
    });
  }
}

class NodeCancelled extends Error {
  constructor() {
    super("The node was cancelled.");
    this.name = "NodeCancelled";
  }
}

class NodeTimeout extends Error {
  constructor() {
    super("The node exceeded its time budget.");
    this.name = "NodeTimeout";
  }
}

function classifyError(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} {
  if (error instanceof NodeCancelled) {
    return { code: "execution_error", message: error.message, retryable: true };
  }
  if (error instanceof NodeTimeout) {
    return { code: "timeout", message: error.message, retryable: true };
  }
  const name = error instanceof Error ? error.name : "";
  if (name === "InvalidModelResponse") {
    return {
      code: "invalid_jev_result",
      message: "Jev returned a malformed decision.",
      retryable: false,
    };
  }
  if (name === "ModelTransportError") {
    return {
      code: "model_error",
      message: "Jev reported a decision execution error.",
      retryable: true,
    };
  }
  // Caller-side validation (bad questions/state) is not retryable.
  if (error instanceof TypeError || error instanceof RangeError) {
    return {
      code: "invalid_jev_request",
      message: "The Jev request was rejected before dispatch.",
      retryable: false,
    };
  }
  return {
    code: "execution_error",
    message: "Jev failed during node execution.",
    retryable: true,
  };
}
