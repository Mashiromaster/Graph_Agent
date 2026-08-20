import { assertBoundedInt, assertNonEmptyText, assertUnitInterval } from "./guards.js";

export interface SpawnProposal {
  readonly proposalId: string;
  readonly parentNodeId: string;
  readonly generation: number;
  readonly role: string;
  readonly objective: string;
  readonly instructions: string;
  readonly toolNames: readonly string[];
  readonly priority: number;
  readonly budgetShare: number;
}

export function createSpawnProposal(input: {
  proposalId: string;
  parentNodeId: string;
  generation: number;
  role: string;
  objective: string;
  instructions: string;
  toolNames?: readonly string[];
  priority?: number;
  budgetShare?: number;
}): SpawnProposal {
  const toolNames = (input.toolNames ?? []).map((name, index) =>
    assertNonEmptyText(name, `toolNames[${index}]`),
  );
  return Object.freeze({
    proposalId: assertNonEmptyText(input.proposalId, "proposalId"),
    parentNodeId: assertNonEmptyText(input.parentNodeId, "parentNodeId"),
    generation: assertBoundedInt(input.generation, "generation", { min: 0 }),
    role: assertNonEmptyText(input.role, "role"),
    objective: assertNonEmptyText(input.objective, "objective"),
    instructions: assertNonEmptyText(input.instructions, "instructions"),
    toolNames: Object.freeze(toolNames),
    priority: assertUnitInterval(input.priority ?? 0.5, "priority"),
    budgetShare: assertUnitInterval(input.budgetShare ?? 0.25, "budgetShare"),
  });
}

export interface MessageProposal {
  readonly proposalId: string;
  readonly sourceNodeId: string;
  readonly targetNodeId: string;
  readonly content: string;
  readonly priority: number;
  readonly ttlSeconds: number;
}

export function createMessageProposal(input: {
  proposalId: string;
  sourceNodeId: string;
  targetNodeId: string;
  content: string;
  priority?: number;
  ttlSeconds?: number;
}): MessageProposal {
  return Object.freeze({
    proposalId: assertNonEmptyText(input.proposalId, "proposalId"),
    sourceNodeId: assertNonEmptyText(input.sourceNodeId, "sourceNodeId"),
    targetNodeId: assertNonEmptyText(input.targetNodeId, "targetNodeId"),
    content: assertNonEmptyText(input.content, "content"),
    priority: assertUnitInterval(input.priority ?? 0.5, "priority"),
    ttlSeconds: assertBoundedInt(input.ttlSeconds ?? 300, "ttlSeconds", { min: 0 }),
  });
}

export interface SkipContextProposal {
  readonly proposalId: string;
  readonly requesterNodeId: string;
  readonly sourceNodeId: string;
  readonly reason: string;
  readonly contextGate: number;
}

export function createSkipContextProposal(input: {
  proposalId: string;
  requesterNodeId: string;
  sourceNodeId: string;
  reason: string;
  contextGate?: number;
}): SkipContextProposal {
  return Object.freeze({
    proposalId: assertNonEmptyText(input.proposalId, "proposalId"),
    requesterNodeId: assertNonEmptyText(input.requesterNodeId, "requesterNodeId"),
    sourceNodeId: assertNonEmptyText(input.sourceNodeId, "sourceNodeId"),
    reason: assertNonEmptyText(input.reason, "reason"),
    contextGate: assertUnitInterval(input.contextGate ?? 0.5, "contextGate"),
  });
}
