import { describe, expect, it } from "vitest";
import { createAgentIdentity } from "../src/identity.js";

describe("createAgentIdentity", () => {
  it("applies defaults", () => {
    const id = createAgentIdentity({ nodeId: "n1", name: "root", role: "orchestrator" });
    expect(id.generation).toBe(0);
    expect(id.parentNodeId).toBeNull();
    expect(id.trustScore).toBe(1);
  });

  it("freezes the returned object", () => {
    const id = createAgentIdentity({ nodeId: "n1", name: "root", role: "r" });
    expect(Object.isFrozen(id)).toBe(true);
    expect(() => {
      (id as { nodeId: string }).nodeId = "x";
    }).toThrow();
  });

  it("rejects empty nodeId", () => {
    expect(() =>
      createAgentIdentity({ nodeId: "  ", name: "n", role: "r" }),
    ).toThrow(RangeError);
  });

  it("rejects negative generation", () => {
    expect(() =>
      createAgentIdentity({ nodeId: "n1", name: "n", role: "r", generation: -1 }),
    ).toThrow(RangeError);
  });

  it("rejects trustScore outside [0,1]", () => {
    expect(() =>
      createAgentIdentity({ nodeId: "n1", name: "n", role: "r", trustScore: 1.5 }),
    ).toThrow(RangeError);
  });
});
