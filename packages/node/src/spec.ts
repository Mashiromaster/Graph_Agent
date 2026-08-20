import type { AgentIdentity, NodeBudget } from "@graph-agent/core";
import { assertBoolean, assertBoundedInt, assertNonEmptyText } from "@graph-agent/core";

export interface NodePolicy {
  readonly maxGeneration: number;
  readonly maxChildren: number;
  readonly allowDirectMessages: boolean;
  readonly allowSkipContext: boolean;
}

export interface AgentSpec {
  readonly identity: AgentIdentity;
  readonly budget: NodeBudget;
  readonly instructions: string;
  readonly role?: string;
  readonly policy: NodePolicy;
}

export function createAgentSpec(input: {
  identity: AgentIdentity;
  budget: NodeBudget;
  instructions: string;
  role?: string;
  policy?: {
    maxGeneration?: number;
    maxChildren?: number;
    allowDirectMessages?: boolean;
    allowSkipContext?: boolean;
  };
}): AgentSpec {
  const policyInput = input.policy ?? {};
  const policy: NodePolicy = Object.freeze({
    maxGeneration: assertBoundedInt(policyInput.maxGeneration ?? 4, "maxGeneration", {
      min: 0,
    }),
    maxChildren: assertBoundedInt(policyInput.maxChildren ?? 8, "maxChildren", { min: 0 }),
    allowDirectMessages: assertBoolean(
      policyInput.allowDirectMessages ?? false,
      "allowDirectMessages",
    ),
    allowSkipContext: assertBoolean(
      policyInput.allowSkipContext ?? false,
      "allowSkipContext",
    ),
  });
  return Object.freeze({
    identity: input.identity,
    budget: input.budget,
    instructions: assertNonEmptyText(input.instructions, "instructions"),
    ...(input.role !== undefined
      ? { role: assertNonEmptyText(input.role, "role") }
      : {}),
    policy,
  });
}
