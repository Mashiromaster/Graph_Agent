import { describe, expect, it } from "vitest";
import { JevDecisionClient, assertJevQuestions } from "../src/jev.js";
import type { JevQuestion } from "../src/jev.js";
import type { JSONTransport } from "../src/transport.js";
import { InvalidModelResponse, ModelTransportError } from "../src/transport.js";

class CaptureTransport implements JSONTransport {
  calls: Array<{
    url: string;
    headers: Record<string, string>;
    payload: unknown;
    timeoutSeconds: number;
  }> = [];
  constructor(private readonly response: unknown) {}
  async postJson(args: {
    url: string;
    headers: Record<string, string>;
    payload: unknown;
    timeoutSeconds: number;
  }) {
    this.calls.push(args);
    return this.response;
  }
}

class ThrowingTransport implements JSONTransport {
  constructor(private readonly error: Error) {}
  async postJson(): Promise<unknown> {
    throw this.error;
  }
}

const QUESTIONS: Readonly<Record<string, JevQuestion>> = {
  department: {
    type: "choice",
    instructions: "Which team should handle this?",
    criteria: { billing: "Payments and refunds", technical: "Bugs and outages" },
  },
  urgent: { type: "noul", instructions: "Does this convey urgency?" },
  frustration: {
    type: "score",
    instructions: "How frustrated is the customer?",
    criteria: ["calm", "neutral", "angry"],
  },
};

const CANNED = {
  model: "jev-1.13.0",
  answers: {
    department: {
      type: "choice",
      choice: "technical",
      confidence: 0.81,
      probabilities: { billing: 0.08, technical: 0.89 },
    },
    urgent: { type: "noul", noul: 0.99 },
    frustration: {
      type: "score",
      score: 0.67,
      confidence: 0.5,
      legend: { "0": "calm", "1": "neutral", "2": "angry" },
      probabilities: { "0": 0.33, "1": 0.67, "2": 0 },
    },
  },
  usage: { input_tokens: 428, output_tokens: 73 },
};

function client(transport: JSONTransport, extra: Record<string, unknown> = {}) {
  return new JevDecisionClient({ apiKey: "sk-jev-secret-1234", transport, ...extra });
}

describe("assertJevQuestions", () => {
  it("accepts all three question types", () => {
    expect(() => assertJevQuestions(QUESTIONS)).not.toThrow();
  });

  it("accepts noul with explicit true/false criteria", () => {
    expect(() =>
      assertJevQuestions({
        q: {
          type: "noul",
          instructions: "urgent?",
          criteria: { true: "outage or deadline", false: "general question" },
        },
      }),
    ).not.toThrow();
  });

  it("rejects an empty or non-object question set", () => {
    expect(() => assertJevQuestions({})).toThrow(/must not be empty/);
    expect(() => assertJevQuestions(null as never)).toThrow(/plain object/);
  });

  it("rejects an unknown question type", () => {
    expect(() =>
      assertJevQuestions({ q: { type: "ranking", instructions: "x" } as never }),
    ).toThrow(/must be one of choice, noul, score/);
  });

  it("rejects blank instructions", () => {
    expect(() =>
      assertJevQuestions({ q: { type: "noul", instructions: "   " } }),
    ).toThrow(/instructions/);
  });

  it("rejects a choice with fewer than two options", () => {
    expect(() =>
      assertJevQuestions({
        q: { type: "choice", instructions: "x", criteria: { only: "one" } },
      }),
    ).toThrow(/at least 2 options/);
  });

  it("rejects a score whose criteria is not an ordered array", () => {
    expect(() =>
      assertJevQuestions({
        q: { type: "score", instructions: "x", criteria: { low: "a" } as never },
      }),
    ).toThrow(/ordered array/);
  });

  it("rejects noul criteria missing a branch", () => {
    expect(() =>
      assertJevQuestions({
        q: { type: "noul", instructions: "x", criteria: { true: "a" } as never },
      }),
    ).toThrow(/"true" and "false"/);
  });
});

describe("JevDecisionClient.decide request", () => {
  it("posts to /systemone with a bearer token and the question set", async () => {
    const transport = new CaptureTransport(CANNED);
    await client(transport).decide({ state: "payouts failing", questions: QUESTIONS });

    const call = transport.calls[0]!;
    expect(call.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(call.headers["Authorization"]).toBe("Bearer sk-jev-secret-1234");
    const payload = call.payload as Record<string, unknown>;
    expect(payload["model"]).toBe("jev-latest");
    expect(payload["state"]).toBe("payouts failing");
    expect(payload["questions"]).toEqual(QUESTIONS);
  });

  it("passes a structured state through without flattening it", async () => {
    const transport = new CaptureTransport(CANNED);
    const state = { ticket: "double charged", account_tier: "business" };
    await client(transport).decide({ state, questions: QUESTIONS });
    expect((transport.calls[0]!.payload as Record<string, unknown>)["state"]).toEqual(state);
  });

  it("honours a custom base url and model", async () => {
    const transport = new CaptureTransport(CANNED);
    await client(transport, {
      baseUrl: "https://gateway.example.com/v1/",
      model: "jev-1.13",
    }).decide({ state: "x", questions: QUESTIONS });
    expect(transport.calls[0]!.url).toBe("https://gateway.example.com/v1/systemone");
    expect((transport.calls[0]!.payload as Record<string, unknown>)["model"]).toBe("jev-1.13");
  });

  it("requires an api key", () => {
    const previous = process.env["TYPESAFE_API_KEY"];
    delete process.env["TYPESAFE_API_KEY"];
    try {
      expect(() => new JevDecisionClient()).toThrow(/apiKey is required/);
    } finally {
      if (previous !== undefined) process.env["TYPESAFE_API_KEY"] = previous;
    }
  });

  it("falls back to TYPESAFE_API_KEY", async () => {
    const previous = process.env["TYPESAFE_API_KEY"];
    process.env["TYPESAFE_API_KEY"] = "sk-from-env-jev";
    try {
      const transport = new CaptureTransport(CANNED);
      await new JevDecisionClient({ transport }).decide({ state: "x", questions: QUESTIONS });
      expect(transport.calls[0]!.headers["Authorization"]).toBe("Bearer sk-from-env-jev");
    } finally {
      if (previous === undefined) delete process.env["TYPESAFE_API_KEY"];
      else process.env["TYPESAFE_API_KEY"] = previous;
    }
  });

  it("validates questions before spending a request", async () => {
    const transport = new CaptureTransport(CANNED);
    await expect(client(transport).decide({ state: "x", questions: {} })).rejects.toThrow();
    expect(transport.calls).toEqual([]);
  });

  it("rejects a non-object, non-string state", async () => {
    const transport = new CaptureTransport(CANNED);
    await expect(
      client(transport).decide({ state: 42 as never, questions: QUESTIONS }),
    ).rejects.toThrow(/state must be/);
    expect(transport.calls).toEqual([]);
  });

  it("rejects an oversized state", async () => {
    const transport = new CaptureTransport(CANNED);
    await expect(
      client(transport).decide({ state: "x".repeat(300_000), questions: QUESTIONS }),
    ).rejects.toThrow(/maximum serialized size/);
    expect(transport.calls).toEqual([]);
  });
});

describe("JevDecisionClient.decide response", () => {
  it("parses all three answer types and usage", async () => {
    const decision = await client(new CaptureTransport(CANNED)).decide({
      state: "x",
      questions: QUESTIONS,
    });

    expect(decision.model).toBe("jev-1.13.0");
    expect(decision.inputTokens).toBe(428);
    expect(decision.outputTokens).toBe(73);

    expect(decision.answers["department"]).toEqual({
      type: "choice",
      choice: "technical",
      noul: null,
      score: null,
      probabilities: { billing: 0.08, technical: 0.89 },
      confidence: 0.81,
      legend: null,
    });
    expect(decision.answers["urgent"]!.noul).toBe(0.99);
    expect(decision.answers["frustration"]!.score).toBe(0.67);
    expect(decision.answers["frustration"]!.legend).toEqual({
      "0": "calm",
      "1": "neutral",
      "2": "angry",
    });
  });

  it("keeps probability and confidence as distinct values", async () => {
    const decision = await client(new CaptureTransport(CANNED)).decide({
      state: "x",
      questions: QUESTIONS,
    });
    const answer = decision.answers["department"]!;
    // Upstream warns these must not be conflated: 0.89 mass vs 0.81 confidence.
    expect(answer.probabilities["technical"]).toBe(0.89);
    expect(answer.confidence).toBe(0.81);
    expect(answer.confidence).not.toBe(answer.probabilities["technical"]);
  });

  it("reports noul with no confidence field rather than inventing one", async () => {
    const decision = await client(new CaptureTransport(CANNED)).decide({
      state: "x",
      questions: QUESTIONS,
    });
    expect(decision.answers["urgent"]!.confidence).toBeNull();
  });

  it("rejects a response missing an asked question", async () => {
    const partial = { ...CANNED, answers: { department: CANNED.answers.department } };
    await expect(
      client(new CaptureTransport(partial)).decide({ state: "x", questions: QUESTIONS }),
    ).rejects.toThrow(/missing answers\.urgent/);
  });

  it("rejects a malformed answer payload", async () => {
    for (const answers of [
      { ...CANNED.answers, department: { type: "choice", probabilities: {} } },
      { ...CANNED.answers, urgent: { type: "noul", noul: 1.5 } },
      { ...CANNED.answers, frustration: { type: "score", score: "high" } },
      { ...CANNED.answers, urgent: { type: "mystery" } },
    ]) {
      await expect(
        client(new CaptureTransport({ ...CANNED, answers })).decide({
          state: "x",
          questions: QUESTIONS,
        }),
      ).rejects.toBeInstanceOf(InvalidModelResponse);
    }
  });

  it("rejects a response with no answers object", async () => {
    await expect(
      client(new CaptureTransport({ model: "jev-1.13.0" })).decide({
        state: "x",
        questions: QUESTIONS,
      }),
    ).rejects.toThrow(/no answers object/);
  });

  it("defaults usage to zero when absent", async () => {
    const noUsage = { model: "jev-1.13.0", answers: CANNED.answers };
    const decision = await client(new CaptureTransport(noUsage)).decide({
      state: "x",
      questions: QUESTIONS,
    });
    expect(decision.inputTokens).toBe(0);
    expect(decision.outputTokens).toBe(0);
  });

  it("propagates transport failures", async () => {
    await expect(
      client(new ThrowingTransport(new ModelTransportError("boom"))).decide({
        state: "x",
        questions: QUESTIONS,
      }),
    ).rejects.toBeInstanceOf(ModelTransportError);
  });
});
