import { assertNonEmptyText } from "@graph-agent/core";
import type { Usage } from "@graph-agent/core";
import { createUsage } from "@graph-agent/core";

export type MessageRole = "system" | "user" | "assistant" | "tool" | "context";

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface Message {
  readonly role: MessageRole;
  readonly content: string | null;
  readonly toolCalls?: readonly ToolCall[];
  readonly name?: string;
  readonly toolCallId?: string;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export interface ModelRequest {
  readonly nodeId: string;
  readonly instructions: string;
  readonly messages: readonly Message[];
  readonly tools: readonly ToolDefinition[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface ModelResponse {
  readonly content: string | null;
  readonly toolCalls: readonly ToolCall[];
  readonly usage: Usage;
  readonly finishReason: string | null;
}

export function createToolCall(input: {
  id: string;
  name: string;
  arguments?: Readonly<Record<string, unknown>>;
}): ToolCall {
  return Object.freeze({
    id: assertNonEmptyText(input.id, "id"),
    name: assertNonEmptyText(input.name, "name"),
    arguments: Object.freeze({ ...(input.arguments ?? {}) }),
  });
}

export function createMessage(input: {
  role: MessageRole;
  content: string | null;
  toolCalls?: readonly ToolCall[];
  name?: string;
  toolCallId?: string;
}): Message {
  return Object.freeze({
    role: input.role,
    content: input.content,
    toolCalls: Object.freeze([...(input.toolCalls ?? [])]),
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.toolCallId !== undefined ? { toolCallId: input.toolCallId } : {}),
  });
}

export function createToolDefinition(input: {
  name: string;
  description: string;
  inputSchema?: Readonly<Record<string, unknown>>;
}): ToolDefinition {
  return Object.freeze({
    name: assertNonEmptyText(input.name, "name"),
    description: input.description,
    inputSchema: Object.freeze({ ...(input.inputSchema ?? {}) }),
  });
}

export function createModelRequest(input: {
  nodeId: string;
  instructions: string;
  messages?: readonly Message[];
  tools?: readonly ToolDefinition[];
  metadata?: Readonly<Record<string, unknown>>;
}): ModelRequest {
  return Object.freeze({
    nodeId: assertNonEmptyText(input.nodeId, "nodeId"),
    instructions: input.instructions,
    messages: Object.freeze([...(input.messages ?? [])]),
    tools: Object.freeze([...(input.tools ?? [])]),
    metadata: Object.freeze({ ...(input.metadata ?? {}) }),
  });
}

export function createModelResponse(input: {
  content: string | null;
  toolCalls?: readonly ToolCall[];
  usage?: Usage;
  finishReason?: string | null;
}): ModelResponse {
  return Object.freeze({
    content: input.content,
    toolCalls: Object.freeze([...(input.toolCalls ?? [])]),
    usage: input.usage ?? createUsage(),
    finishReason: input.finishReason ?? null,
  });
}
