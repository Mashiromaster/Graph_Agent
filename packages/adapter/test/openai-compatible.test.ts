import { describe, expect, it } from "vitest";
import { OpenAICompatibleModel } from "../src/openai-compatible.js";
import { InvalidModelResponse } from "../src/openai-compatible.js";
import type { JSONTransport } from "../src/transport.js";
import { createMessage, createModelRequest, createToolCall, createToolDefinition } from "../src/model-types.js";

class CaptureTransport implements JSONTransport {
  calls: Array<{ url: string; headers: Record<string, string>; payload: unknown; timeoutSeconds: number }> = [];
  constructor(private readonly response: unknown) {}
  async postJson(args: { url: string; headers: Record<string, string>; payload: unknown; timeoutSeconds: number }) {
    this.calls.push(args);
    return this.response;
  }
}

const cannedResponse = {
  choices: [
    {
      message: {
        content: "hi there",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "search", arguments: '{"q":"cats"}' },
          },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: { prompt_tokens: 12, completion_tokens: 5 },
};

describe("OpenAICompatibleModel construction", () => {
  it("rejects empty model", () => {
    expect(() => new OpenAICompatibleModel({ model: "  " })).toThrow();
  });

  it("rejects a non-loopback http baseUrl", () => {
    expect(() => new OpenAICompatibleModel({ model: "m", baseUrl: "http://api.example.com/v1" })).toThrow();
  });

  it("allows a loopback http baseUrl", () => {
    expect(() => new OpenAICompatibleModel({ model: "m", baseUrl: "http://localhost:8080/v1" })).not.toThrow();
    expect(() => new OpenAICompatibleModel({ model: "m", baseUrl: "http://127.0.0.1:8080/v1" })).not.toThrow();
  });

  it("rejects baseUrl with query", () => {
    expect(() => new OpenAICompatibleModel({ model: "m", baseUrl: "https://api.openai.com/v1?x=1" })).toThrow();
  });

  it("rejects baseUrl with fragment/user/pass", () => {
    expect(() => new OpenAICompatibleModel({ model: "m", baseUrl: "https://api.openai.com/v1#frag" })).toThrow();
    expect(() => new OpenAICompatibleModel({ model: "m", baseUrl: "https://user:pw@api.openai.com/v1" })).toThrow();
  });

  it("rejects timeoutSeconds 0", () => {
    expect(() => new OpenAICompatibleModel({ model: "m", timeoutSeconds: 0 })).toThrow();
  });

  it("rejects a non-finite timeoutSeconds", () => {
    expect(() => new OpenAICompatibleModel({ model: "m", timeoutSeconds: Infinity })).toThrow();
    expect(() => new OpenAICompatibleModel({ model: "m", timeoutSeconds: Number.NaN })).toThrow();
  });

  it("rejects non-integer / <1 maxOutputTokens", () => {
    expect(() => new OpenAICompatibleModel({ model: "m", maxOutputTokens: 0 })).toThrow();
    expect(() => new OpenAICompatibleModel({ model: "m", maxOutputTokens: 1.5 })).toThrow();
  });

  it("rejects reserved extraBody keys", () => {
    expect(() => new OpenAICompatibleModel({ model: "m", extraBody: { model: "x" } })).toThrow();
    expect(() => new OpenAICompatibleModel({ model: "m", extraBody: { max_tokens: 1 } })).toThrow();
  });

  it("rejects an oversized extraBody", () => {
    const big = { pad: "y".repeat(17000) };
    expect(() => new OpenAICompatibleModel({ model: "m", extraBody: big })).toThrow();
  });
});

describe("OpenAICompatibleModel.complete request building", () => {
  it("builds the expected request body and headers", async () => {
    const transport = new CaptureTransport(cannedResponse);
    const model = new OpenAICompatibleModel({
      model: "gpt-4o",
      apiKey: "sk-test",
      baseUrl: "https://api.openai.com/v1/",
      maxOutputTokens: 256,
      extraBody: { temperature: 0.2 },
      transport,
    });
    const request = createModelRequest({
      nodeId: "n1",
      instructions: "be helpful",
      messages: [
        createMessage({ role: "context", content: "ctx info" }),
        createMessage({ role: "user", content: "hello", name: "alice" }),
        createMessage({
          role: "assistant",
          content: null,
          toolCalls: [createToolCall({ id: "c1", name: "search", arguments: { q: "cats" } })],
        }),
        createMessage({ role: "tool", content: "result", toolCallId: "c1" }),
      ],
      tools: [
        createToolDefinition({
          name: "search",
          description: "search the web",
          inputSchema: { type: "object" },
        }),
      ],
    });
    await model.complete(request);
    const call = transport.calls[0]!;
    expect(call.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(call.headers.Authorization).toBe("Bearer sk-test");
    expect(call.headers["Content-Type"]).toBe("application/json");
    const body = call.payload as Record<string, any>;
    expect(body.model).toBe("gpt-4o");
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(256);
    expect(body.messages[0]).toEqual({ role: "system", content: "be helpful" });
    expect(body.messages[1]).toEqual({ role: "user", content: "ctx info" });
    expect(body.messages[2]).toEqual({ role: "user", content: "hello", name: "alice" });
    expect(body.messages[3]).toMatchObject({ role: "assistant", content: null });
    expect(body.messages[3].tool_calls[0]).toEqual({
      id: "c1",
      type: "function",
      function: { name: "search", arguments: '{"q":"cats"}' },
    });
    expect(body.messages[4]).toEqual({ role: "tool", content: "result", tool_call_id: "c1" });
    expect(body.tools[0]).toEqual({
      type: "function",
      function: { name: "search", description: "search the web", parameters: { type: "object" } },
    });
  });

  it("omits Authorization when no apiKey and non-openai host", async () => {
    const transport = new CaptureTransport(cannedResponse);
    const model = new OpenAICompatibleModel({
      model: "m",
      baseUrl: "http://localhost:1234/v1",
      transport,
    });
    await model.complete(createModelRequest({ nodeId: "n1", instructions: "x" }));
    expect(transport.calls[0]!.headers.Authorization).toBeUndefined();
  });

  it("throws when a tool message lacks toolCallId", async () => {
    const transport = new CaptureTransport(cannedResponse);
    const model = new OpenAICompatibleModel({ model: "m", apiKey: "k", transport });
    const request = createModelRequest({
      nodeId: "n1",
      instructions: "x",
      messages: [createMessage({ role: "tool", content: "r" })],
    });
    await expect(model.complete(request)).rejects.toThrow();
  });
});

describe("OpenAICompatibleModel.complete response parsing", () => {
  const build = (response: unknown) =>
    new OpenAICompatibleModel({ model: "m", apiKey: "k", transport: new CaptureTransport(response) });

  it("parses content, tool calls, usage, and finish reason", async () => {
    const model = build(cannedResponse);
    const res = await model.complete(createModelRequest({ nodeId: "n1", instructions: "x" }));
    expect(res.content).toBe("hi there");
    expect(res.toolCalls[0]!.name).toBe("search");
    expect(res.toolCalls[0]!.arguments).toEqual({ q: "cats" });
    expect(res.usage.inputTokens).toBe(12);
    expect(res.usage.outputTokens).toBe(5);
    expect(res.finishReason).toBe("tool_calls");
  });

  it("concatenates array text-part content", async () => {
    const model = build({
      choices: [
        {
          message: {
            content: [
              { type: "text", text: "a" },
              { type: "image", url: "ignored" },
              { type: "text", text: "b" },
            ],
          },
          finish_reason: "stop",
        },
      ],
    });
    const res = await model.complete(createModelRequest({ nodeId: "n1", instructions: "x" }));
    expect(res.content).toBe("ab");
  });

  it("coerces missing usage to zero", async () => {
    const model = build({ choices: [{ message: { content: "y" }, finish_reason: null }] });
    const res = await model.complete(createModelRequest({ nodeId: "n1", instructions: "x" }));
    expect(res.usage.inputTokens).toBe(0);
    expect(res.usage.outputTokens).toBe(0);
    expect(res.finishReason).toBeNull();
  });

  it("throws InvalidModelResponse when no choice", async () => {
    const model = build({ choices: [] });
    await expect(
      model.complete(createModelRequest({ nodeId: "n1", instructions: "x" })),
    ).rejects.toBeInstanceOf(InvalidModelResponse);
  });

  it("throws InvalidModelResponse on a malformed tool call", async () => {
    const model = build({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ id: "x", type: "function", function: { name: "f", arguments: "[1,2]" } }],
          },
        },
      ],
    });
    await expect(
      model.complete(createModelRequest({ nodeId: "n1", instructions: "x" })),
    ).rejects.toBeInstanceOf(InvalidModelResponse);
  });

  it("throws InvalidModelResponse on a non-function tool call type", async () => {
    const model = build({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ id: "x", type: "custom", function: { name: "f", arguments: "{}" } }],
          },
        },
      ],
    });
    await expect(
      model.complete(createModelRequest({ nodeId: "n1", instructions: "x" })),
    ).rejects.toBeInstanceOf(InvalidModelResponse);
  });

  it("throws InvalidModelResponse on a non-string / missing tool-call id", async () => {
    const numericId = build({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ id: 42, type: "function", function: { name: "f", arguments: "{}" } }],
          },
        },
      ],
    });
    await expect(
      numericId.complete(createModelRequest({ nodeId: "n1", instructions: "x" })),
    ).rejects.toBeInstanceOf(InvalidModelResponse);

    const missingId = build({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [{ type: "function", function: { name: "f", arguments: "{}" } }],
          },
        },
      ],
    });
    await expect(
      missingId.complete(createModelRequest({ nodeId: "n1", instructions: "x" })),
    ).rejects.toBeInstanceOf(InvalidModelResponse);
  });
});
