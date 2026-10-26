/**
 * 控制器策略:编排层的静态上界与门槛值。
 *
 * 所有 `max*` 为正整数字段(≥1),经 `assertBoundedInt(v,label,{min:1})` 校验;
 * `minTrustScore` 为单位区间 [0,1] 值,经 `assertUnitInterval` 校验(可为 0)。
 * 返回值被 `Object.freeze` 冻结。
 */

import { assertBoundedInt, assertUnitInterval } from "@graph-agent/core";

export interface ControllerPolicy {
  readonly maxNodes: number;
  readonly maxEdges: number;
  readonly maxGeneration: number;
  readonly maxChildrenPerNode: number;
  readonly maxTotalTokens: number;
  readonly maxConcurrency: number;
  readonly minTrustScore: number;
  readonly maxProposalsPerResult: number;
  readonly maxEventsPerResult: number;
  readonly maxTextLength: number;
  readonly maxIdLength: number;
  readonly maxMessageTtlSeconds: number;
  /** 单个节点一次 frontier-freeze 可注入的投递 token 上限(估算口径见 delivery.ts)。 */
  readonly contextInjectionTokenBudget: number;
  /** 单个节点一次 frontier-freeze 最多接收的投递条数。 */
  readonly maxDeliveriesPerNode: number;
  /** 打分后进入背包的候选条数上限(Top-K)。 */
  readonly contextTopK: number;
}

const DEFAULTS: ControllerPolicy = {
  maxNodes: 64,
  maxEdges: 256,
  maxGeneration: 4,
  maxChildrenPerNode: 8,
  maxTotalTokens: 64000,
  maxConcurrency: 4,
  minTrustScore: 0,
  maxProposalsPerResult: 32,
  maxEventsPerResult: 512,
  maxTextLength: 16000,
  maxIdLength: 256,
  maxMessageTtlSeconds: 86400,
  contextInjectionTokenBudget: 2000,
  maxDeliveriesPerNode: 8,
  contextTopK: 16,
};

export function createControllerPolicy(
  overrides: Partial<ControllerPolicy> = {},
): ControllerPolicy {
  const merged = { ...DEFAULTS, ...overrides };
  return Object.freeze({
    maxNodes: assertBoundedInt(merged.maxNodes, "maxNodes", { min: 1 }),
    maxEdges: assertBoundedInt(merged.maxEdges, "maxEdges", { min: 1 }),
    maxGeneration: assertBoundedInt(merged.maxGeneration, "maxGeneration", { min: 1 }),
    maxChildrenPerNode: assertBoundedInt(
      merged.maxChildrenPerNode,
      "maxChildrenPerNode",
      { min: 1 },
    ),
    maxTotalTokens: assertBoundedInt(merged.maxTotalTokens, "maxTotalTokens", { min: 1 }),
    maxConcurrency: assertBoundedInt(merged.maxConcurrency, "maxConcurrency", { min: 1 }),
    minTrustScore: assertUnitInterval(merged.minTrustScore, "minTrustScore"),
    maxProposalsPerResult: assertBoundedInt(
      merged.maxProposalsPerResult,
      "maxProposalsPerResult",
      { min: 1 },
    ),
    maxEventsPerResult: assertBoundedInt(
      merged.maxEventsPerResult,
      "maxEventsPerResult",
      { min: 1 },
    ),
    maxTextLength: assertBoundedInt(merged.maxTextLength, "maxTextLength", { min: 1 }),
    maxIdLength: assertBoundedInt(merged.maxIdLength, "maxIdLength", { min: 1 }),
    maxMessageTtlSeconds: assertBoundedInt(
      merged.maxMessageTtlSeconds,
      "maxMessageTtlSeconds",
      { min: 1 },
    ),
    contextInjectionTokenBudget: assertBoundedInt(
      merged.contextInjectionTokenBudget,
      "contextInjectionTokenBudget",
      { min: 1 },
    ),
    maxDeliveriesPerNode: assertBoundedInt(
      merged.maxDeliveriesPerNode,
      "maxDeliveriesPerNode",
      { min: 1 },
    ),
    contextTopK: assertBoundedInt(merged.contextTopK, "contextTopK", { min: 1 }),
  });
}
