import { describe, expect, it } from "vitest";
import { addUsage, createNodeBudget, createUsage, usageTotalTokens } from "../src/budget.js";

describe("createNodeBudget", () => {
  it("applies defaults", () => {
    const b = createNodeBudget();
    expect(b).toEqual({
      maxTurns: 8,
      maxToolCalls: 16,
      maxTotalTokens: 32000,
      timeoutSeconds: 120,
    });
    expect(Object.isFrozen(b)).toBe(true);
  });

  it("rejects maxTurns below 1", () => {
    expect(() => createNodeBudget({ maxTurns: 0 })).toThrow(RangeError);
  });

  it("rejects negative maxToolCalls", () => {
    expect(() => createNodeBudget({ maxToolCalls: -1 })).toThrow(RangeError);
  });

  it("rejects non-positive timeoutSeconds", () => {
    expect(() => createNodeBudget({ timeoutSeconds: 0 })).toThrow(RangeError);
  });
});

describe("Usage", () => {
  it("defaults to zero and freezes", () => {
    const u = createUsage();
    expect(u).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(Object.isFrozen(u)).toBe(true);
  });

  it("rejects negative tokens", () => {
    expect(() => createUsage({ inputTokens: -1 })).toThrow(RangeError);
  });

  it("computes total tokens", () => {
    expect(usageTotalTokens(createUsage({ inputTokens: 3, outputTokens: 4 }))).toBe(7);
  });

  it("adds two usages", () => {
    const sum = addUsage(
      createUsage({ inputTokens: 1, outputTokens: 2 }),
      createUsage({ inputTokens: 3, outputTokens: 4 }),
    );
    expect(sum).toEqual({ inputTokens: 4, outputTokens: 6 });
    expect(Object.isFrozen(sum)).toBe(true);
  });
});
