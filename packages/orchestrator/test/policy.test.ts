import { describe, expect, it } from "vitest";
import { createControllerPolicy } from "../src/policy.js";

describe("createControllerPolicy", () => {
  it("应用精确的默认值", () => {
    const policy = createControllerPolicy();
    expect(policy).toEqual({
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
    });
  });

  it("返回被冻结的记录", () => {
    expect(Object.isFrozen(createControllerPolicy())).toBe(true);
  });

  it("接受覆盖值", () => {
    expect(createControllerPolicy({ maxNodes: 10 }).maxNodes).toBe(10);
    expect(createControllerPolicy({ minTrustScore: 0.5 }).minTrustScore).toBe(0.5);
  });

  it("拒绝非正整数字段", () => {
    expect(() => createControllerPolicy({ maxNodes: 0 })).toThrow();
    expect(() => createControllerPolicy({ maxTotalTokens: -1 })).toThrow();
    expect(() => createControllerPolicy({ maxConcurrency: 1.5 })).toThrow();
  });

  it("拒绝越界的 minTrustScore", () => {
    expect(() => createControllerPolicy({ minTrustScore: -0.1 })).toThrow();
    expect(() => createControllerPolicy({ minTrustScore: 1.1 })).toThrow();
  });
});
