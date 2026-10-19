import type { AgentIdentity, NodeBudget } from "@graph-agent/core";
import {
  assertBoolean,
  assertBoundedInt,
  assertNonEmptyText,
  createAgentIdentity,
  createNodeBudget,
} from "@graph-agent/core";

export interface NodePolicy {
  readonly maxGeneration: number;
  readonly maxChildren: number;
  readonly allowDirectMessages: boolean;
  readonly allowSkipContext: boolean;
  /**
   * 本节点可为子节点请求的模型类型。空数组(默认)= 不得携带 model_kind。
   * 这是节点侧的**预校验**,与控制器的 policy.allowedModelKinds 相互独立:
   * 它让模型尽早拿到拒绝理由,但真正的信任边界仍在控制器。
   */
  readonly allowedModelKinds: readonly string[];
}

export interface AgentSpec {
  readonly identity: AgentIdentity;
  readonly budget: NodeBudget;
  readonly instructions: string;
  readonly role?: string;
  readonly policy: NodePolicy;
  /** 本节点自身绑定的模型类型;省略表示由工厂决定。 */
  readonly modelKind?: string;
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
    allowedModelKinds?: readonly string[];
  };
  modelKind?: string;
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
    allowedModelKinds: Object.freeze(
      [
        ...new Set(
          (policyInput.allowedModelKinds ?? []).map((kind, index) =>
            assertNonEmptyText(kind, `allowedModelKinds[${index}]`),
          ),
        ),
      ].sort(),
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
    ...(input.modelKind !== undefined
      ? { modelKind: assertNonEmptyText(input.modelKind, "modelKind") }
      : {}),
  });
}

/**
 * Project an AgentSpec into a plain, JSON-safe dict for checkpointing.
 * `role` is omitted entirely when undefined (conditional spread) to stay
 * compatible with exactOptionalPropertyTypes on the round-trip.
 */
export function agentSpecToDict(spec: AgentSpec): Record<string, unknown> {
  const { identity, budget, policy } = spec;
  return {
    identity: {
      nodeId: identity.nodeId,
      name: identity.name,
      role: identity.role,
      generation: identity.generation,
      parentNodeId: identity.parentNodeId,
      trustScore: identity.trustScore,
    },
    budget: {
      maxTurns: budget.maxTurns,
      maxToolCalls: budget.maxToolCalls,
      maxTotalTokens: budget.maxTotalTokens,
      timeoutSeconds: budget.timeoutSeconds,
    },
    instructions: spec.instructions,
    ...(spec.role !== undefined ? { role: spec.role } : {}),
    policy: {
      maxGeneration: policy.maxGeneration,
      maxChildren: policy.maxChildren,
      allowDirectMessages: policy.allowDirectMessages,
      allowSkipContext: policy.allowSkipContext,
      allowedModelKinds: [...policy.allowedModelKinds],
    },
    ...(spec.modelKind !== undefined ? { modelKind: spec.modelKind } : {}),
  };
}

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

/**
 * Rebuild an AgentSpec from a dict produced by {@link agentSpecToDict}.
 * Fail-closed: any missing/malformed field throws via the core factories'
 * own guards (createAgentIdentity / createNodeBudget / createAgentSpec).
 */
export function agentSpecFromDict(value: unknown): AgentSpec {
  const dict = assertRecord(value, "agentSpec");
  const identityDict = assertRecord(dict.identity, "identity");
  const budgetDict = assertRecord(dict.budget, "budget");
  const policyDict = assertRecord(dict.policy, "policy");

  const identity = createAgentIdentity({
    nodeId: identityDict.nodeId as string,
    name: identityDict.name as string,
    role: identityDict.role as string,
    ...(identityDict.generation !== undefined
      ? { generation: identityDict.generation as number }
      : {}),
    ...(identityDict.parentNodeId !== undefined
      ? { parentNodeId: identityDict.parentNodeId as string | null }
      : {}),
    ...(identityDict.trustScore !== undefined
      ? { trustScore: identityDict.trustScore as number }
      : {}),
  });
  const budget = createNodeBudget({
    ...(budgetDict.maxTurns !== undefined
      ? { maxTurns: budgetDict.maxTurns as number }
      : {}),
    ...(budgetDict.maxToolCalls !== undefined
      ? { maxToolCalls: budgetDict.maxToolCalls as number }
      : {}),
    ...(budgetDict.maxTotalTokens !== undefined
      ? { maxTotalTokens: budgetDict.maxTotalTokens as number }
      : {}),
    ...(budgetDict.timeoutSeconds !== undefined
      ? { timeoutSeconds: budgetDict.timeoutSeconds as number }
      : {}),
  });
  if (typeof dict.instructions !== "string") {
    throw new Error("instructions must be a string");
  }
  const rawAllowedKinds = policyDict.allowedModelKinds;
  if (rawAllowedKinds !== undefined && !Array.isArray(rawAllowedKinds)) {
    throw new Error("allowedModelKinds must be an array");
  }
  return createAgentSpec({
    identity,
    budget,
    instructions: dict.instructions,
    ...(dict.role !== undefined ? { role: dict.role as string } : {}),
    policy: {
      maxGeneration: assertBoundedInt(
        policyDict.maxGeneration as number,
        "maxGeneration",
        { min: 0 },
      ),
      maxChildren: assertBoundedInt(policyDict.maxChildren as number, "maxChildren", {
        min: 0,
      }),
      allowDirectMessages: assertBoolean(
        policyDict.allowDirectMessages as boolean,
        "allowDirectMessages",
      ),
      allowSkipContext: assertBoolean(
        policyDict.allowSkipContext as boolean,
        "allowSkipContext",
      ),
      // 缺失视为空(兼容本字段引入前写出的 checkpoint)。
      allowedModelKinds: (rawAllowedKinds as string[] | undefined) ?? [],
    },
    ...(dict.modelKind !== undefined ? { modelKind: dict.modelKind as string } : {}),
  });
}
