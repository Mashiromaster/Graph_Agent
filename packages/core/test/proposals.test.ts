import { describe, expect, it } from "vitest";
import {
  createMessageProposal,
  createSkipContextProposal,
  createSpawnProposal,
} from "../src/proposals.js";

describe("createSpawnProposal", () => {
  it("applies defaults and freezes", () => {
    const p = createSpawnProposal({
      proposalId: "p1",
      parentNodeId: "n0",
      generation: 1,
      role: "researcher",
      objective: "find X",
      instructions: "do the research",
    });
    expect(p.toolNames).toEqual([]);
    expect(p.priority).toBe(0.5);
    expect(p.budgetShare).toBe(0.25);
    expect(Object.isFrozen(p)).toBe(true);
    expect(Object.isFrozen(p.toolNames)).toBe(true);
  });
  it("rejects generation below 0", () => {
    expect(() =>
      createSpawnProposal({
        proposalId: "p1",
        parentNodeId: "n0",
        generation: -1,
        role: "r",
        objective: "o",
        instructions: "i",
      }),
    ).toThrow(RangeError);
  });
  it("rejects budgetShare outside [0,1]", () => {
    expect(() =>
      createSpawnProposal({
        proposalId: "p1",
        parentNodeId: "n0",
        generation: 1,
        role: "r",
        objective: "o",
        instructions: "i",
        budgetShare: 1.5,
      }),
    ).toThrow(RangeError);
  });
});

describe("createMessageProposal", () => {
  it("applies defaults and freezes", () => {
    const p = createMessageProposal({
      proposalId: "p2",
      sourceNodeId: "a",
      targetNodeId: "b",
      content: "hi",
    });
    expect(p.priority).toBe(0.5);
    expect(p.ttlSeconds).toBe(300);
    expect(Object.isFrozen(p)).toBe(true);
  });
  it("rejects negative ttlSeconds", () => {
    expect(() =>
      createMessageProposal({
        proposalId: "p2",
        sourceNodeId: "a",
        targetNodeId: "b",
        content: "hi",
        ttlSeconds: -1,
      }),
    ).toThrow(RangeError);
  });
});

describe("createSkipContextProposal", () => {
  it("applies defaults and freezes", () => {
    const p = createSkipContextProposal({
      proposalId: "p3",
      requesterNodeId: "a",
      sourceNodeId: "b",
      reason: "not relevant",
    });
    expect(p.contextGate).toBe(0.5);
    expect(Object.isFrozen(p)).toBe(true);
  });
  it("rejects contextGate outside [0,1]", () => {
    expect(() =>
      createSkipContextProposal({
        proposalId: "p3",
        requesterNodeId: "a",
        sourceNodeId: "b",
        reason: "r",
        contextGate: -0.1,
      }),
    ).toThrow(RangeError);
  });
});
