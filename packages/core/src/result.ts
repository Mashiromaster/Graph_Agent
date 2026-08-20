import type { Usage } from "./budget.js";
import { assertBoolean, assertNonEmptyText, assertUnitInterval } from "./guards.js";
import type { MessageProposal, SkipContextProposal, SpawnProposal } from "./proposals.js";
import type { RunEvent } from "./events.js";

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
