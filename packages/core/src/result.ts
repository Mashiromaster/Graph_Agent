import { createUsage, type Usage } from "./budget.js";
import { assertBoolean, assertNonEmptyText, assertUnitInterval } from "./guards.js";
import {
  createMessageProposal,
  createSkipContextProposal,
  createSpawnProposal,
  type MessageProposal,
  type SkipContextProposal,
  type SpawnProposal,
} from "./proposals.js";
import { runEventFromDict, runEventToDict, type RunEvent } from "./events.js";

export const NodeStatus = Object.freeze({
  COMPLETED: "completed",
  FAILED: "failed",
} as const);

export type NodeStatus = (typeof NodeStatus)[keyof typeof NodeStatus];

export interface NodeError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export function createNodeError(input: {
  code: string;
  message: string;
  retryable?: boolean;
}): NodeError {
  return Object.freeze({
    code: assertNonEmptyText(input.code, "code"),
    message: assertNonEmptyText(input.message, "message"),
    retryable: assertBoolean(input.retryable ?? false, "retryable"),
  });
}

export interface ContextPacket {
  readonly sourceNodeId: string;
  readonly content: string;
  readonly trust: number;
  readonly edgeType: string;
}

export function createContextPacket(input: {
  sourceNodeId: string;
  content: string;
  trust?: number;
  edgeType?: string;
}): ContextPacket {
  return Object.freeze({
    sourceNodeId: assertNonEmptyText(input.sourceNodeId, "sourceNodeId"),
    content: assertNonEmptyText(input.content, "content"),
    trust: assertUnitInterval(input.trust ?? 1, "trust"),
    edgeType: assertNonEmptyText(input.edgeType ?? "message", "edgeType"),
  });
}

export interface AgentInput {
  readonly task: string;
  readonly context: readonly ContextPacket[];
  readonly sessionId: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export function createAgentInput(input: {
  task: string;
  context?: readonly ContextPacket[];
  sessionId?: string | null;
  metadata?: Record<string, unknown>;
}): AgentInput {
  const sessionId = input.sessionId ?? null;
  return Object.freeze({
    task: assertNonEmptyText(input.task, "task"),
    context: Object.freeze([...(input.context ?? [])]),
    sessionId: sessionId === null ? null : assertNonEmptyText(sessionId, "sessionId"),
    metadata: Object.freeze({ ...(input.metadata ?? {}) }),
  });
}

export interface AgentResult {
  readonly nodeId: string;
  readonly status: NodeStatus;
  readonly output: string | null;
  readonly usage: Usage;
  readonly events: readonly RunEvent[];
  readonly spawnProposals: readonly SpawnProposal[];
  readonly messageProposals: readonly MessageProposal[];
  readonly skipContextProposals: readonly SkipContextProposal[];
  readonly error: NodeError | null;
}

export function createAgentResult(input: {
  nodeId: string;
  status: NodeStatus;
  output: string | null;
  usage: Usage;
  events: readonly RunEvent[];
  spawnProposals?: readonly SpawnProposal[];
  messageProposals?: readonly MessageProposal[];
  skipContextProposals?: readonly SkipContextProposal[];
  error?: NodeError | null;
}): AgentResult {
  return Object.freeze({
    nodeId: assertNonEmptyText(input.nodeId, "nodeId"),
    status: input.status,
    output: input.output,
    usage: input.usage,
    events: Object.freeze([...input.events]),
    spawnProposals: Object.freeze([...(input.spawnProposals ?? [])]),
    messageProposals: Object.freeze([...(input.messageProposals ?? [])]),
    skipContextProposals: Object.freeze([...(input.skipContextProposals ?? [])]),
    error: input.error ?? null,
  });
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  return value;
}

export function agentInputToDict(input: AgentInput): Record<string, unknown> {
  return {
    task: input.task,
    context: input.context.map((packet) => ({
      sourceNodeId: packet.sourceNodeId,
      content: packet.content,
      trust: packet.trust,
      edgeType: packet.edgeType,
    })),
    sessionId: input.sessionId,
    metadata: { ...input.metadata },
  };
}

export function agentInputFromDict(value: unknown): AgentInput {
  const record = asObject(value, "agentInput");
  const context = asArray(record.context ?? [], "context").map((entry) => {
    const packet = asObject(entry, "contextPacket");
    return createContextPacket({
      sourceNodeId: packet.sourceNodeId as string,
      content: packet.content as string,
      trust: packet.trust as number,
      edgeType: packet.edgeType as string,
    });
  });
  const sessionId = record.sessionId;
  if (sessionId !== null && sessionId !== undefined && typeof sessionId !== "string") {
    throw new TypeError("sessionId must be a string or null");
  }
  const metadata = asObject(record.metadata ?? {}, "metadata");
  return createAgentInput({
    task: record.task as string,
    context,
    sessionId: (sessionId ?? null) as string | null,
    metadata: { ...metadata },
  });
}

export function agentResultToDict(result: AgentResult): Record<string, unknown> {
  return {
    nodeId: result.nodeId,
    status: result.status,
    output: result.output,
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    },
    events: result.events.map(runEventToDict),
    spawnProposals: result.spawnProposals.map((p) => ({ ...p, toolNames: [...p.toolNames] })),
    messageProposals: result.messageProposals.map((p) => ({ ...p })),
    skipContextProposals: result.skipContextProposals.map((p) => ({ ...p })),
    error:
      result.error === null
        ? null
        : {
            code: result.error.code,
            message: result.error.message,
            retryable: result.error.retryable,
          },
  };
}

export function agentResultFromDict(value: unknown): AgentResult {
  const record = asObject(value, "agentResult");
  const status = record.status;
  if (status !== NodeStatus.COMPLETED && status !== NodeStatus.FAILED) {
    throw new RangeError("status must be a valid NodeStatus");
  }
  const output = record.output;
  if (output !== null && output !== undefined && typeof output !== "string") {
    throw new TypeError("output must be a string or null");
  }
  const usage = asObject(record.usage, "usage");
  const errorValue = record.error;
  const error =
    errorValue === null || errorValue === undefined
      ? null
      : createNodeError(
          ((): { code: string; message: string; retryable: boolean } => {
            const e = asObject(errorValue, "error");
            return {
              code: e.code as string,
              message: e.message as string,
              retryable: assertBoolean(e.retryable as boolean, "retryable"),
            };
          })(),
        );
  return createAgentResult({
    nodeId: record.nodeId as string,
    status,
    output: (output ?? null) as string | null,
    usage: createUsage({
      inputTokens: usage.inputTokens as number,
      outputTokens: usage.outputTokens as number,
    }),
    events: asArray(record.events, "events").map(runEventFromDict),
    spawnProposals: asArray(record.spawnProposals ?? [], "spawnProposals").map((entry) => {
      const p = asObject(entry, "spawnProposal");
      return createSpawnProposal({
        proposalId: p.proposalId as string,
        parentNodeId: p.parentNodeId as string,
        generation: p.generation as number,
        role: p.role as string,
        objective: p.objective as string,
        instructions: p.instructions as string,
        toolNames: asArray(p.toolNames ?? [], "toolNames") as string[],
        priority: p.priority as number,
        budgetShare: p.budgetShare as number,
      });
    }),
    messageProposals: asArray(record.messageProposals ?? [], "messageProposals").map(
      (entry) => {
        const p = asObject(entry, "messageProposal");
        return createMessageProposal({
          proposalId: p.proposalId as string,
          sourceNodeId: p.sourceNodeId as string,
          targetNodeId: p.targetNodeId as string,
          content: p.content as string,
          priority: p.priority as number,
          ttlSeconds: p.ttlSeconds as number,
        });
      },
    ),
    skipContextProposals: asArray(
      record.skipContextProposals ?? [],
      "skipContextProposals",
    ).map((entry) => {
      const p = asObject(entry, "skipContextProposal");
      return createSkipContextProposal({
        proposalId: p.proposalId as string,
        requesterNodeId: p.requesterNodeId as string,
        sourceNodeId: p.sourceNodeId as string,
        reason: p.reason as string,
        contextGate: p.contextGate as number,
      });
    }),
    error,
  });
}
