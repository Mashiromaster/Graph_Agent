import { describe, it, expect } from "vitest";
import { createAgentIdentity, createNodeBudget } from "@graph-agent/core";
import { createAgentSpec, agentSpecToDict, agentSpecFromDict } from "../src/index.js";

describe("agentSpec dict projection", () => {
  it("round-trips a rich AgentSpec through toDict -> fromDict", () => {
    const spec = createAgentSpec({
      identity: createAgentIdentity({
        nodeId: "n1",
        name: "Planner",
        role: "planner",
        generation: 2,
        parentNodeId: "root",
        trustScore: 0.5,
      }),
      budget: createNodeBudget({
        maxTurns: 5,
        maxToolCalls: 10,
        maxTotalTokens: 4000,
        timeoutSeconds: 60,
      }),
      instructions: "do the thing",
      role: "planner",
      policy: {
        maxGeneration: 3,
        maxChildren: 6,
        allowDirectMessages: true,
        allowSkipContext: true,
      },
    });

    const dict = agentSpecToDict(spec);
    const rebuilt = agentSpecFromDict(dict);

    expect(rebuilt).toEqual(spec);
  });

  it("round-trips a spec with no role field", () => {
    const spec = createAgentSpec({
      identity: createAgentIdentity({ nodeId: "n2", name: "Worker", role: "worker" }),
      budget: createNodeBudget(),
      instructions: "work",
    });
    const rebuilt = agentSpecFromDict(agentSpecToDict(spec));
    expect(rebuilt).toEqual(spec);
    expect("role" in (agentSpecToDict(spec) as Record<string, unknown>)).toBe(false);
  });

  it("throws on a non-object value", () => {
    expect(() => agentSpecFromDict(null)).toThrow();
    expect(() => agentSpecFromDict("nope")).toThrow();
  });

  it("throws when instructions are missing", () => {
    const spec = createAgentSpec({
      identity: createAgentIdentity({ nodeId: "n3", name: "W", role: "worker" }),
      budget: createNodeBudget(),
      instructions: "x",
    });
    const dict = agentSpecToDict(spec) as Record<string, unknown>;
    delete dict.instructions;
    expect(() => agentSpecFromDict(dict)).toThrow();
  });

  it("throws when policy is malformed", () => {
    const spec = createAgentSpec({
      identity: createAgentIdentity({ nodeId: "n4", name: "W", role: "worker" }),
      budget: createNodeBudget(),
      instructions: "x",
    });
    const dict = agentSpecToDict(spec) as Record<string, unknown>;
    dict.policy = "bad";
    expect(() => agentSpecFromDict(dict)).toThrow();
  });
});
