import { describe, expect, it } from "vitest";
import {
  createMessage,
  createModelRequest,
  createModelResponse,
  createToolCall,
  createToolDefinition,
} from "../src/model-types.js";

describe("createToolCall", () => {
  it("builds a frozen tool call with frozen arguments", () => {
    const call = createToolCall({ id: "call-1", name: "search", arguments: { query: "hi" } });
    expect(call).toEqual({ id: "call-1", name: "search", arguments: { query: "hi" } });
    expect(Object.isFrozen(call)).toBe(true);
    expect(Object.isFrozen(call.arguments)).toBe(true);
  });

  it("defaults arguments to an empty object", () => {
    const call = createToolCall({ id: "call-1", name: "noop" });
    expect(call.arguments).toEqual({});
  });

  it("rejects empty id or name", () => {
    expect(() => createToolCall({ id: "", name: "x" })).toThrow();
    expect(() => createToolCall({ id: "x", name: "" })).toThrow();
  });
});

describe("createMessage", () => {
  it("allows null content and defaults toolCalls to empty frozen array", () => {
    const msg = createMessage({ role: "assistant", content: null });
    expect(msg.role).toBe("assistant");
    expect(msg.content).toBeNull();
    expect(msg.toolCalls).toEqual([]);
    expect(Object.isFrozen(msg)).toBe(true);
    expect(Object.isFrozen(msg.toolCalls)).toBe(true);
  });

  it("preserves and freezes provided tool calls, name, toolCallId", () => {
    const call = createToolCall({ id: "c1", name: "search" });
    const msg = createMessage({
      role: "tool",
      content: "result",
      toolCalls: [call],
      name: "search",
      toolCallId: "c1",
    });
    expect(msg.toolCalls).toEqual([call]);
    expect(msg.name).toBe("search");
    expect(msg.toolCallId).toBe("c1");
    expect(Object.isFrozen(msg.toolCalls)).toBe(true);
  });
});

describe("createToolDefinition", () => {
  it("builds a frozen tool definition with frozen input schema", () => {
    const def = createToolDefinition({
      name: "search",
      description: "search the web",
      inputSchema: { type: "object" },
    });
    expect(def).toEqual({
      name: "search",
      description: "search the web",
      inputSchema: { type: "object" },
    });
    expect(Object.isFrozen(def)).toBe(true);
    expect(Object.isFrozen(def.inputSchema)).toBe(true);
  });

  it("defaults inputSchema to empty object and rejects empty name", () => {
    const def = createToolDefinition({ name: "noop", description: "" });
    expect(def.inputSchema).toEqual({});
    expect(() => createToolDefinition({ name: "", description: "x" })).toThrow();
  });
});

describe("createModelRequest", () => {
  it("builds a frozen request with frozen collections and default metadata", () => {
    const req = createModelRequest({
      nodeId: "n1",
      instructions: "do the thing",
      messages: [createMessage({ role: "user", content: "hi" })],
      tools: [createToolDefinition({ name: "search", description: "d", inputSchema: {} })],
    });
    expect(req.nodeId).toBe("n1");
    expect(req.instructions).toBe("do the thing");
    expect(req.metadata).toEqual({});
    expect(Object.isFrozen(req)).toBe(true);
    expect(Object.isFrozen(req.messages)).toBe(true);
    expect(Object.isFrozen(req.tools)).toBe(true);
    expect(Object.isFrozen(req.metadata)).toBe(true);
  });

  it("defaults messages and tools to empty arrays", () => {
    const req = createModelRequest({ nodeId: "n1", instructions: "x" });
    expect(req.messages).toEqual([]);
    expect(req.tools).toEqual([]);
  });
});

describe("createModelResponse", () => {
  it("builds a frozen response with defaults", () => {
    const res = createModelResponse({ content: "hello" });
    expect(res.content).toBe("hello");
    expect(res.toolCalls).toEqual([]);
    expect(res.finishReason).toBeNull();
    expect(res.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(Object.isFrozen(res)).toBe(true);
    expect(Object.isFrozen(res.toolCalls)).toBe(true);
  });

  it("preserves provided usage, tool calls, and finish reason", () => {
    const call = createToolCall({ id: "c1", name: "search" });
    const res = createModelResponse({
      content: null,
      toolCalls: [call],
      usage: { inputTokens: 3, outputTokens: 5 },
      finishReason: "tool_calls",
    });
    expect(res.content).toBeNull();
    expect(res.toolCalls).toEqual([call]);
    expect(res.usage).toEqual({ inputTokens: 3, outputTokens: 5 });
    expect(res.finishReason).toBe("tool_calls");
    expect(Object.isFrozen(res.toolCalls)).toBe(true);
  });
});
