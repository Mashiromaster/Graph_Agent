import { describe, expect, it } from "vitest";
import {
  createAgentIdentity,
  createAgentInput,
  createContextPacket,
  createNodeBudget,
  verifyEventChain,
} from "@graph-agent/core";
import type { JevDecision, JevQuestion } from "@graph-agent/adapter";
import { InvalidModelResponse, ModelTransportError } from "@graph-agent/adapter";
import { createAgentSpec } from "../src/spec.js";
import { JevNode, type JevDecider } from "../src/jev-node.js";

const QUESTIONS: Readonly<Record<string, JevQuestion>> = {
  route: {
    type: "choice",
    instructions: "Which team handles this?",
    criteria: { billing: "payments", technical: "outages" },
  },
  urgent: { type: "noul", instructions: "Is this urgent?" },
};

const DECISION: JevDecision = Object.freeze({
  model: "jev-1.13.0",
  answers: Object.freeze({
    route: {
      type: "choice" as const,
      choice: "technical",
      noul: null,
      score: null,
      probabilities: { billing: 0.1, technical: 0.9 },
      confidence: 0.82,
      legend: null,
    },
    urgent: {
      type: "noul" as const,
      choice: null,
      noul: 0.97,
      score: null,
      probabilities: {},
      confidence: null,
      legend: null,
    },
  }),
  inputTokens: 120,
  outputTokens: 18,
});

class StubDecider implements JevDecider {
  calls: Array<{ state: unknown; questions: unknown }> = [];
  constructor(private readonly decision: JevDecision = DECISION) {}
  async decide(input: { state: unknown; questions: unknown }) {
    this.calls.push(input);
    return this.decision;
  }
}

class FailingDecider implements JevDecider {
  constructor(private readonly error: Error) {}
  async decide(): Promise<JevDecision> {
    throw this.error;
  }
}

class HangingDecider implements JevDecider {
  async decide(): Promise<JevDecision> {
    return new Promise(() => {});
  }
}

function spec(overrides: { maxTotalTokens?: number; timeoutSeconds?: number } = {}) {
  return createAgentSpec({
    identity: createAgentIdentity({
      nodeId: "decider",
      name: "Router",
      role: "router",
      generation: 1,
    }),
    instructions: "Route the ticket.",
    budget: createNodeBudget({
      maxTurns: 1,
      maxToolCalls: 0,
      maxTotalTokens: overrides.maxTotalTokens ?? 1000,
      timeoutSeconds: overrides.timeoutSeconds ?? 30,
    }),
  });
}

function node(client: JevDecider, overrides?: { maxTotalTokens?: number; timeoutSeconds?: number }) {
  return new JevNode({ spec: spec(overrides), questions: QUESTIONS, client, clock: () => 0 });
}

describe("JevNode", () => {
  it("returns the decision as canonical JSON with a verifiable event chain", async () => {
    const result = await node(new StubDecider()).run(createAgentInput({ task: "payouts down" }));

    expect(result.status).toBe("completed");
    expect(result.error).toBeNull();
    expect(verifyEventChain(result.events)).toBe(true);

    const parsed = JSON.parse(result.output!);
    expect(parsed.model).toBe("jev-1.13.0");
    expect(parsed.answers.route.choice).toBe("technical");
    expect(parsed.answers.urgent.noul).toBe(0.97);
  });

  it("keeps probability and confidence separate in the serialized output", async () => {
    const result = await node(new StubDecider()).run(createAgentInput({ task: "x" }));
    const route = JSON.parse(result.output!).answers.route;
    expect(route.probabilities.technical).toBe(0.9);
    expect(route.confidence).toBe(0.82);
  });

  it("omits answer fields that do not apply to the question type", async () => {
    const result = await node(new StubDecider()).run(createAgentInput({ task: "x" }));
    const { route, urgent } = JSON.parse(result.output!).answers;
    // A choice answer carries no noul/score; a noul answer no choice/confidence.
    expect("noul" in route).toBe(false);
    expect("score" in route).toBe(false);
    expect("choice" in urgent).toBe(false);
    expect("confidence" in urgent).toBe(false);
  });

  it("is deterministic: identical input yields a byte-identical result", async () => {
    const a = await node(new StubDecider()).run(createAgentInput({ task: "same" }));
    const b = await node(new StubDecider()).run(createAgentInput({ task: "same" }));
    expect(a.output).toBe(b.output);
    expect(a.events.map((e) => e.eventHash)).toEqual(b.events.map((e) => e.eventHash));
  });

  it("reports token usage from the decision", async () => {
    const result = await node(new StubDecider()).run(createAgentInput({ task: "x" }));
    expect(result.usage.inputTokens).toBe(120);
    expect(result.usage.outputTokens).toBe(18);
  });

  it("never emits proposals — Jev cannot request graph changes", async () => {
    const result = await node(new StubDecider()).run(createAgentInput({ task: "x" }));
    expect(result.spawnProposals).toEqual([]);
    expect(result.messageProposals).toEqual([]);
    expect(result.skipContextProposals).toEqual([]);
  });

  it("sends the spec's questions, not anything derived from input", async () => {
    const client = new StubDecider();
    await node(client).run(createAgentInput({ task: "x" }));
    expect(client.calls[0]!.questions).toEqual(QUESTIONS);
  });

  it("passes task and labelled untrusted context as structured state", async () => {
    const client = new StubDecider();
    await node(client).run(
      createAgentInput({
        task: "route it",
        context: [
          createContextPacket({
            sourceNodeId: "parent",
            content: "customer is a business tier account",
            trust: 0.8,
            edgeType: "spawn",
          }),
        ],
      }),
    );
    expect(client.calls[0]!.state).toEqual({
      task: "route it",
      context: [
        {
          source_node_id: "parent",
          edge_type: "spawn",
          trust: 0.8,
          content: "customer is a business tier account",
        },
      ],
    });
  });

  it("fails closed when the token budget is exceeded", async () => {
    const result = await node(new StubDecider(), { maxTotalTokens: 50 }).run(
      createAgentInput({ task: "x" }),
    );
    expect(result.status).toBe("failed");
    expect(result.output).toBeNull();
    expect(result.error).toEqual({
      code: "token_budget_exceeded",
      message: "The node exceeded its token budget.",
      retryable: false,
    });
    expect(result.events.some((e) => e.type === "budget_exceeded")).toBe(true);
  });

  it("does not call the decider for an already-aborted node", async () => {
    const client = new StubDecider();
    const result = await node(client).run(
      createAgentInput({ task: "x" }),
      AbortSignal.abort(),
    );
    expect(client.calls).toEqual([]);
    expect(result.status).toBe("failed");
    expect(result.error?.message).toBe("The node was cancelled.");
  });

  it("stops on mid-flight cancellation", async () => {
    const controller = new AbortController();
    const promise = node(new HangingDecider()).run(
      createAgentInput({ task: "x" }),
      controller.signal,
    );
    controller.abort();
    const result = await promise;
    expect(result.status).toBe("failed");
    expect(result.error).toEqual({
      code: "execution_error",
      message: "The node was cancelled.",
      retryable: true,
    });
  });

  it("times out according to the node budget", async () => {
    const result = await node(new HangingDecider(), { timeoutSeconds: 0.01 }).run(
      createAgentInput({ task: "x" }),
    );
    expect(result.status).toBe("failed");
    expect(result.error).toEqual({
      code: "timeout",
      message: "The node exceeded its time budget.",
      retryable: true,
    });
  });

  it("classifies a malformed decision as non-retryable without leaking upstream text", async () => {
    const result = await node(
      new FailingDecider(new InvalidModelResponse("answers.route.choice must be a string")),
    ).run(createAgentInput({ task: "x" }));
    expect(result.error).toEqual({
      code: "invalid_jev_result",
      message: "Jev returned a malformed decision.",
      retryable: false,
    });
    expect(JSON.stringify(result)).not.toContain("must be a string");
  });

  it("classifies a transport failure as a retryable model error", async () => {
    const result = await node(
      new FailingDecider(new ModelTransportError("Model endpoint returned HTTP 503")),
    ).run(createAgentInput({ task: "x" }));
    expect(result.error).toEqual({
      code: "model_error",
      message: "Jev reported a decision execution error.",
      retryable: true,
    });
    expect(JSON.stringify(result)).not.toContain("503");
  });

  it("classifies pre-dispatch validation errors as non-retryable", async () => {
    const result = await node(new FailingDecider(new RangeError("state too large"))).run(
      createAgentInput({ task: "x" }),
    );
    expect(result.error).toEqual({
      code: "invalid_jev_request",
      message: "The Jev request was rejected before dispatch.",
      retryable: false,
    });
  });

  it("keeps the event chain verifiable on failure too", async () => {
    const result = await node(new FailingDecider(new Error("boom"))).run(
      createAgentInput({ task: "x" }),
    );
    expect(result.status).toBe("failed");
    expect(verifyEventChain(result.events)).toBe(true);
  });
});
