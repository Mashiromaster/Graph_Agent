import { describe, expect, it } from "vitest";
import { createUsage } from "../src/budget.js";
import { EventRecorder, EventType, verifyEventChain } from "../src/events.js";
import { createSpawnProposal } from "../src/proposals.js";
import {
  agentInputFromDict,
  agentInputToDict,
  agentResultFromDict,
  agentResultToDict,
  createAgentInput,
  createAgentResult,
  createContextPacket,
  createNodeError,
  NodeStatus,
} from "../src/result.js";

function fixedClock(): () => number {
  let t = 1000;
  return () => (t += 1);
}

function buildCompletedResult() {
  const rec = new EventRecorder("n1", fixedClock());
  rec.record({ type: EventType.NODE_STARTED, inputValue: "task" });
  rec.record({ type: EventType.NODE_COMPLETED, outputValue: "answer" });
  const spawn = createSpawnProposal({
    proposalId: "p1",
    parentNodeId: "n1",
    generation: 1,
    role: "researcher",
    objective: "dig",
    instructions: "go deep",
    toolNames: ["search"],
  });
  return createAgentResult({
    nodeId: "n1",
    status: NodeStatus.COMPLETED,
    output: "answer",
    usage: createUsage({ inputTokens: 12, outputTokens: 7 }),
    events: rec.events,
    spawnProposals: [spawn],
  });
}

function buildFailedResult() {
  const rec = new EventRecorder("n2", fixedClock());
  rec.record({ type: EventType.NODE_STARTED });
  rec.record({ type: EventType.NODE_FAILED, metadata: { reason: "boom" } });
  return createAgentResult({
    nodeId: "n2",
    status: NodeStatus.FAILED,
    output: null,
    usage: createUsage({ inputTokens: 3, outputTokens: 0 }),
    events: rec.events,
    error: createNodeError({ code: "E_FAIL", message: "boom", retryable: true }),
  });
}

describe("agentInput dict projection", () => {
  it("round-trips deep-equal", () => {
    const input = createAgentInput({
      task: "solve it",
      context: [
        createContextPacket({
          sourceNodeId: "up1",
          content: "prior context",
          trust: 0.9,
          edgeType: "message",
        }),
      ],
      sessionId: "sess-1",
      metadata: { priority: "high", nested: { k: 1 } },
    });
    const rebuilt = agentInputFromDict(agentInputToDict(input));
    expect(rebuilt).toEqual(input);
  });

  it("round-trips with null sessionId and empty context", () => {
    const input = createAgentInput({ task: "bare" });
    expect(agentInputFromDict(agentInputToDict(input))).toEqual(input);
  });

  it("throws on non-object", () => {
    expect(() => agentInputFromDict(null)).toThrow(TypeError);
    expect(() => agentInputFromDict("nope")).toThrow(TypeError);
  });

  it("throws on missing task", () => {
    expect(() => agentInputFromDict({ context: [], sessionId: null, metadata: {} })).toThrow();
  });

  it("throws on non-array context", () => {
    expect(() =>
      agentInputFromDict({ task: "x", context: "bad", sessionId: null, metadata: {} }),
    ).toThrow(TypeError);
  });
});

describe("agentResult dict projection", () => {
  it("round-trips a completed result deep-equal + chain still verifies", () => {
    const result = buildCompletedResult();
    const dict = agentResultToDict(result);
    const rebuilt = agentResultFromDict(dict);
    expect(rebuilt).toEqual(result);
    expect(verifyEventChain(rebuilt.events)).toBe(true);
    // hashes preserved verbatim
    expect(rebuilt.events.map((e) => e.eventHash)).toEqual(
      result.events.map((e) => e.eventHash),
    );
  });

  it("round-trips a failed result with a NodeError", () => {
    const result = buildFailedResult();
    const rebuilt = agentResultFromDict(agentResultToDict(result));
    expect(rebuilt).toEqual(result);
    expect(verifyEventChain(rebuilt.events)).toBe(true);
    expect(rebuilt.error).toEqual(result.error);
  });

  it("throws on non-object", () => {
    expect(() => agentResultFromDict(42)).toThrow(TypeError);
  });

  it("throws on missing nodeId", () => {
    const dict = agentResultToDict(buildCompletedResult());
    delete (dict as Record<string, unknown>).nodeId;
    expect(() => agentResultFromDict(dict)).toThrow();
  });

  it("throws on bad status", () => {
    const dict = agentResultToDict(buildCompletedResult());
    (dict as Record<string, unknown>).status = "weird";
    expect(() => agentResultFromDict(dict)).toThrow(RangeError);
  });

  it("throws on non-array events", () => {
    const dict = agentResultToDict(buildCompletedResult());
    (dict as Record<string, unknown>).events = "not-array";
    expect(() => agentResultFromDict(dict)).toThrow(TypeError);
  });

  it("throws on malformed event (bad hash)", () => {
    const dict = agentResultToDict(buildCompletedResult()) as Record<string, unknown>;
    const events = dict.events as Array<Record<string, unknown>>;
    events[0]!.eventHash = "xyz";
    expect(() => agentResultFromDict(dict)).toThrow(RangeError);
  });
});
