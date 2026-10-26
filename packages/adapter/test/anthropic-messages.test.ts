/**
 * AnthropicMessagesModel 的线格式契约测试,全部用 fake transport(无网络)。
 *
 * 实测端点返回的响应形状已固定在 fixtures 里(含 thinking 块),故这些测试
 * 校验的是真实格式,而非猜测的格式。
 */

import { describe, expect, it } from "vitest";
import { AnthropicMessagesModel } from "../src/anthropic-messages.js";
import { InvalidModelResponse } from "../src/transport.js";
import type { JSONTransport } from "../src/transport.js";
import {
  createMessage,
  createModelRequest,
  createToolDefinition,
} from "../src/model-types.js";

interface Captured {
  url: string;
  headers: Record<string, string>;
  payload: Record<string, unknown>;
}

function fakeTransport(responses: unknown[]): JSONTransport & { calls: Captured[] } {
  const calls: Captured[] = [];
  let index = 0;
  return {
    calls,
    async postJson(args) {
      calls.push({
        url: args.url,
        headers: args.headers,
        payload: args.payload as Record<string, unknown>,
      });
      if (index >= responses.length) {
        throw new Error("fake transport exhausted");
      }
      return responses[index++];
    },
  };
}

/** 实测端点返回的真实形状(来自一次探测调用)。 */
function textResponse(text: string, inTok = 16, outTok = 4): unknown {
  return {
    model: "claude-fable-5",
    id: "msg_01",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: inTok, output_tokens: outTok },
  };
}

/** 带 thinking 块的工具调用响应——实测带 tools 的请求会出现 thinking。 */
function toolUseResponse(): unknown {
  return {
    type: "message",
    role: "assistant",
    content: [
      { type: "thinking", thinking: "internal reasoning", signature: "sig-abc" },
      {
        type: "tool_use",
        id: "toolu_01",
        name: "graph__propose_spawn",
        input: { proposal_id: "sp-1", role: "worker" },
      },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 40, output_tokens: 20 },
  };
}

function model(transport: JSONTransport, temperature?: number): AnthropicMessagesModel {
  return new AnthropicMessagesModel({
    model: "Claude-Fable-5-zl",
    apiKey: "sk-test",
    baseUrl: "https://example.com/anthropic",
    maxOutputTokens: 256,
    ...(temperature !== undefined ? { temperature } : {}),
    transport,
  });
}

describe("AnthropicMessagesModel wire format", () => {
  it("posts to /v1/messages with the required headers", async () => {
    const transport = fakeTransport([textResponse("ok")]);
    await model(transport).complete(
      createModelRequest({ nodeId: "n1", instructions: "be brief" }),
    );
    const call = transport.calls[0]!;
    expect(call.url).toBe("https://example.com/anthropic/v1/messages");
    expect(call.headers["x-api-key"]).toBe("sk-test");
    expect(call.headers["anthropic-version"]).toBe("2023-06-01");
    // Anthropic 用 x-api-key,不是 Bearer。
    expect(call.headers["Authorization"]).toBeUndefined();
  });

  it("sends instructions as the top-level system parameter", async () => {
    const transport = fakeTransport([textResponse("ok")]);
    await model(transport).complete(
      createModelRequest({
        nodeId: "n1",
        instructions: "you are an orchestrator",
        messages: [createMessage({ role: "user", content: "task" })],
      }),
    );
    const payload = transport.calls[0]!.payload;
    expect(payload.system).toBe("you are an orchestrator");
    // system 不得混进 messages。
    const messages = payload.messages as { role: string }[];
    expect(messages.every((m) => m.role !== "system")).toBe(true);
  });

  it("sends tools with input_schema rather than function.parameters", async () => {
    const transport = fakeTransport([textResponse("ok")]);
    await model(transport).complete(
      createModelRequest({
        nodeId: "n1",
        instructions: "i",
        tools: [
          createToolDefinition({
            name: "graph__propose_spawn",
            description: "spawn a child",
            inputSchema: { type: "object", properties: {} },
          }),
        ],
      }),
    );
    const tools = transport.calls[0]!.payload.tools as Record<string, unknown>[];
    expect(tools[0]!.name).toBe("graph__propose_spawn");
    expect(tools[0]!.input_schema).toEqual({ type: "object", properties: {} });
    expect(tools[0]!.function).toBeUndefined();
  });

  it("omits tools when none are supplied", async () => {
    const transport = fakeTransport([textResponse("ok")]);
    await model(transport).complete(
      createModelRequest({ nodeId: "n1", instructions: "i" }),
    );
    expect(transport.calls[0]!.payload.tools).toBeUndefined();
  });

  it("forwards temperature only when set", async () => {
    const withTemp = fakeTransport([textResponse("ok")]);
    await model(withTemp, 0.7).complete(
      createModelRequest({ nodeId: "n1", instructions: "i" }),
    );
    expect(withTemp.calls[0]!.payload.temperature).toBe(0.7);

    const without = fakeTransport([textResponse("ok")]);
    await model(without).complete(createModelRequest({ nodeId: "n1", instructions: "i" }));
    expect(without.calls[0]!.payload.temperature).toBeUndefined();
  });
});

describe("AnthropicMessagesModel response parsing", () => {
  it("maps a text response and Anthropic usage field names", async () => {
    const transport = fakeTransport([textResponse("hello", 123, 45)]);
    const response = await model(transport).complete(
      createModelRequest({ nodeId: "n1", instructions: "i" }),
    );
    expect(response.content).toBe("hello");
    expect(response.toolCalls).toHaveLength(0);
    expect(response.usage.inputTokens).toBe(123);
    expect(response.usage.outputTokens).toBe(45);
    expect(response.finishReason).toBe("end_turn");
  });

  it("extracts tool_use blocks and reports null content alongside them", async () => {
    // content 为 null 让 AgentNode 判定"仍在调工具"而非"已给出终答"。
    const transport = fakeTransport([toolUseResponse()]);
    const response = await model(transport).complete(
      createModelRequest({ nodeId: "n1", instructions: "i" }),
    );
    expect(response.content).toBeNull();
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls[0]!.name).toBe("graph__propose_spawn");
    expect(response.toolCalls[0]!.id).toBe("toolu_01");
    expect(response.toolCalls[0]!.arguments).toEqual({
      proposal_id: "sp-1",
      role: "worker",
    });
  });

  it("concatenates multiple text blocks", async () => {
    const transport = fakeTransport([
      {
        content: [
          { type: "text", text: "part one. " },
          { type: "text", text: "part two." },
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ]);
    const response = await model(transport).complete(
      createModelRequest({ nodeId: "n1", instructions: "i" }),
    );
    expect(response.content).toBe("part one. part two.");
  });

  it("ignores thinking blocks in the projected response", async () => {
    const transport = fakeTransport([
      {
        content: [
          { type: "thinking", thinking: "secret reasoning", signature: "s" },
          { type: "text", text: "visible" },
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    ]);
    const response = await model(transport).complete(
      createModelRequest({ nodeId: "n1", instructions: "i" }),
    );
    expect(response.content).toBe("visible");
    expect(JSON.stringify(response)).not.toContain("secret reasoning");
  });

  it("fails closed on a malformed response", async () => {
    for (const bad of [
      { content: "not-an-array" },
      { content: [{ type: "text" }] },
      { content: [{ type: "tool_use", id: "x" }] },
      { type: "error", error: { message: "bad request" } },
    ]) {
      const transport = fakeTransport([bad]);
      await expect(
        model(transport).complete(createModelRequest({ nodeId: "n1", instructions: "i" })),
      ).rejects.toThrow(InvalidModelResponse);
    }
  });

  it("treats missing usage as zero rather than throwing", async () => {
    const transport = fakeTransport([
      { content: [{ type: "text", text: "x" }], stop_reason: "end_turn" },
    ]);
    const response = await model(transport).complete(
      createModelRequest({ nodeId: "n1", instructions: "i" }),
    );
    expect(response.usage.inputTokens).toBe(0);
  });
});

describe("AnthropicMessagesModel multi-turn tool handling", () => {
  it("replays the cached assistant blocks including thinking on the next turn", async () => {
    // Anthropic 要求多轮工具调用时把上一轮 assistant 内容(含 thinking 块
    // 及其签名)原样放回,否则签名校验失败。核心协议的 ModelResponse 没有
    // thinking 的位置,故适配器内部按 nodeId 缓存并重放。
    const transport = fakeTransport([toolUseResponse(), textResponse("done")]);
    const m = model(transport);

    await m.complete(
      createModelRequest({
        nodeId: "n1",
        instructions: "i",
        messages: [createMessage({ role: "user", content: "task" })],
      }),
    );
    await m.complete(
      createModelRequest({
        nodeId: "n1",
        instructions: "i",
        messages: [
          createMessage({ role: "user", content: "task" }),
          createMessage({ role: "assistant", content: null }),
          createMessage({
            role: "tool",
            content: "tool output",
            toolCallId: "toolu_01",
          }),
        ],
      }),
    );

    const messages = transport.calls[1]!.payload.messages as Record<string, unknown>[];
    const assistant = messages.find((m2) => m2.role === "assistant")!;
    const blocks = assistant.content as Record<string, unknown>[];
    expect(blocks[0]!.type).toBe("thinking");
    expect(blocks[0]!.signature).toBe("sig-abc");
    expect(blocks[1]!.type).toBe("tool_use");
  });

  it("converts tool messages into tool_result blocks on a user message", async () => {
    const transport = fakeTransport([toolUseResponse(), textResponse("done")]);
    const m = model(transport);
    await m.complete(createModelRequest({ nodeId: "n1", instructions: "i" }));
    await m.complete(
      createModelRequest({
        nodeId: "n1",
        instructions: "i",
        messages: [
          createMessage({ role: "assistant", content: null }),
          createMessage({ role: "tool", content: "result A", toolCallId: "toolu_01" }),
        ],
      }),
    );
    const messages = transport.calls[1]!.payload.messages as Record<string, unknown>[];
    const last = messages[messages.length - 1]!;
    expect(last.role).toBe("user");
    const blocks = last.content as Record<string, unknown>[];
    expect(blocks[0]!.type).toBe("tool_result");
    expect(blocks[0]!.tool_use_id).toBe("toolu_01");
    expect(blocks[0]!.content).toBe("result A");
    // 核心协议的 role:"tool" 不得直接出现在 Anthropic 请求里。
    expect(messages.every((msg) => msg.role !== "tool")).toBe(true);
  });

  it("merges consecutive tool results into one user message", async () => {
    // Anthropic 要求同一轮 assistant 的多个 tool_use 的结果在同一条 user 消息里。
    const transport = fakeTransport([toolUseResponse(), textResponse("done")]);
    const m = model(transport);
    await m.complete(createModelRequest({ nodeId: "n1", instructions: "i" }));
    await m.complete(
      createModelRequest({
        nodeId: "n1",
        instructions: "i",
        messages: [
          createMessage({ role: "assistant", content: null }),
          createMessage({ role: "tool", content: "r1", toolCallId: "t1" }),
          createMessage({ role: "tool", content: "r2", toolCallId: "t2" }),
        ],
      }),
    );
    const messages = transport.calls[1]!.payload.messages as Record<string, unknown>[];
    const userMessages = messages.filter((msg) => msg.role === "user");
    const merged = userMessages[userMessages.length - 1]!;
    expect((merged.content as unknown[]).length).toBe(2);
  });

  it("keeps per-node caches separate", async () => {
    const transport = fakeTransport([
      toolUseResponse(),
      textResponse("other node"),
      textResponse("done"),
    ]);
    const m = model(transport);
    await m.complete(createModelRequest({ nodeId: "n1", instructions: "i" }));
    await m.complete(createModelRequest({ nodeId: "n2", instructions: "i" }));
    // n2 的第一轮不应复用 n1 缓存的块。
    await m.complete(
      createModelRequest({
        nodeId: "n2",
        instructions: "i",
        messages: [createMessage({ role: "assistant", content: "other node" })],
      }),
    );
    const messages = transport.calls[2]!.payload.messages as Record<string, unknown>[];
    const assistant = messages.find((msg) => msg.role === "assistant")!;
    const blocks = assistant.content as Record<string, unknown>[];
    expect(blocks[0]!.type).toBe("text");
  });

  it("never sends an empty messages array", async () => {
    const transport = fakeTransport([textResponse("ok")]);
    await model(transport).complete(
      createModelRequest({ nodeId: "n1", instructions: "i" }),
    );
    const messages = transport.calls[0]!.payload.messages as unknown[];
    expect(messages.length).toBeGreaterThan(0);
  });
});

describe("AnthropicMessagesModel construction", () => {
  it("rejects an empty key, bad URL, or non-https remote host", () => {
    const base = {
      model: "m",
      apiKey: "k",
      baseUrl: "https://example.com",
      maxOutputTokens: 16,
    };
    expect(() => new AnthropicMessagesModel({ ...base, apiKey: "  " })).toThrow("apiKey");
    expect(() => new AnthropicMessagesModel({ ...base, baseUrl: "not a url" })).toThrow();
    expect(
      () => new AnthropicMessagesModel({ ...base, baseUrl: "http://example.com" }),
    ).toThrow("https");
    expect(
      () => new AnthropicMessagesModel({ ...base, baseUrl: "https://u:p@example.com" }),
    ).toThrow("credentials");
    expect(
      () => new AnthropicMessagesModel({ ...base, baseUrl: "https://example.com?x=1" }),
    ).toThrow("query string");
  });

  it("allows loopback over http", () => {
    expect(
      () =>
        new AnthropicMessagesModel({
          model: "m",
          apiKey: "k",
          baseUrl: "http://localhost:8080",
          maxOutputTokens: 16,
        }),
    ).not.toThrow();
  });

  it("hides the api key in toString", () => {
    const m = new AnthropicMessagesModel({
      model: "m",
      apiKey: "sk-secret-value",
      baseUrl: "https://example.com",
      maxOutputTokens: 16,
    });
    expect(String(m)).not.toContain("sk-secret-value");
  });
});
