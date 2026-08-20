import { assertBoundedInt, assertNonEmptyText, assertUnitInterval } from "./guards.js";

export interface AgentIdentity {
  readonly nodeId: string;
  readonly name: string;
  readonly role: string;
  readonly generation: number;
  readonly parentNodeId: string | null;
  readonly trustScore: number;
}

export function createAgentIdentity(input: {
  nodeId: string;
  name: string;
  role: string;
  generation?: number;
  parentNodeId?: string | null;
  trustScore?: number;
}): AgentIdentity {
  const generation = input.generation ?? 0;
  const trustScore = input.trustScore ?? 1;
  const parentNodeId = input.parentNodeId ?? null;
  return Object.freeze({
    nodeId: assertNonEmptyText(input.nodeId, "nodeId"),
    name: assertNonEmptyText(input.name, "name"),
    role: assertNonEmptyText(input.role, "role"),
    generation: assertBoundedInt(generation, "generation", { min: 0 }),
    parentNodeId:
      parentNodeId === null ? null : assertNonEmptyText(parentNodeId, "parentNodeId"),
    trustScore: assertUnitInterval(trustScore, "trustScore"),
  });
}
