import { assertBoundedInt, assertFinitePositive } from "./guards.js";

export interface NodeBudget {
  readonly maxTurns: number;
  readonly maxToolCalls: number;
  readonly maxTotalTokens: number;
  readonly timeoutSeconds: number;
}

export function createNodeBudget(
  input: {
    maxTurns?: number;
    maxToolCalls?: number;
    maxTotalTokens?: number;
    timeoutSeconds?: number;
  } = {},
): NodeBudget {
  return Object.freeze({
    maxTurns: assertBoundedInt(input.maxTurns ?? 8, "maxTurns", { min: 1 }),
    maxToolCalls: assertBoundedInt(input.maxToolCalls ?? 16, "maxToolCalls", { min: 0 }),
    maxTotalTokens: assertBoundedInt(input.maxTotalTokens ?? 32000, "maxTotalTokens", {
      min: 1,
    }),
    timeoutSeconds: assertFinitePositive(input.timeoutSeconds ?? 120, "timeoutSeconds"),
  });
}

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export function createUsage(
  input: { inputTokens?: number; outputTokens?: number } = {},
): Usage {
  return Object.freeze({
    inputTokens: assertBoundedInt(input.inputTokens ?? 0, "inputTokens", { min: 0 }),
    outputTokens: assertBoundedInt(input.outputTokens ?? 0, "outputTokens", { min: 0 }),
  });
}

export function usageTotalTokens(usage: Usage): number {
  return usage.inputTokens + usage.outputTokens;
}

export function addUsage(a: Usage, b: Usage): Usage {
  return createUsage({
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  });
}
