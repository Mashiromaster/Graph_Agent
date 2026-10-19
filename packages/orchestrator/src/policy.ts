/**
 * 控制器策略:编排层的静态上界与门槛值。
 *
 * 所有 `max*` 为正整数字段(≥1),经 `assertBoundedInt(v,label,{min:1})` 校验;
 * `minTrustScore` 为单位区间 [0,1] 值,经 `assertUnitInterval` 校验(可为 0)。
 * 返回值被 `Object.freeze` 冻结。
 */

import { assertBoundedInt, assertNonEmptyText, assertUnitInterval } from "@graph-agent/core";

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
  /**
   * 允许被 spawn 提案指定的模型类型白名单。**空数组(默认)表示不允许任何
   * 提案携带 modelKind**——此时任何带 modelKind 的提案都会被拒绝,模型绑定
   * 完全由 NodeFactory 决定(即本字段引入前的历史行为)。
   *
   * fail-closed 的方向性是刻意的:模型选择是权限面(不同模型的成本、外部
   * 网络可达性、数据边界各不相同),故须由宿主显式开启,不能由模型自行扩张。
   */
  readonly allowedModelKinds: readonly string[];
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
  allowedModelKinds: [],
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
    // 去重 + 排序:白名单的集合语义与声明顺序无关,规范化后便于确定性比较。
    allowedModelKinds: Object.freeze(
      [
        ...new Set(
          merged.allowedModelKinds.map((kind, index) =>
            assertNonEmptyText(kind, `allowedModelKinds[${index}]`),
          ),
        ),
      ].sort(),
    ),
  });
}
