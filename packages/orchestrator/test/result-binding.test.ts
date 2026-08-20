import { describe, expect, it } from "vitest";
import {
  EventRecorder,
  EventType,
  NodeStatus,
  createAgentResult,
  createUsage,
  resultBindingHash,
  type AgentResult,
  type RunEvent,
} from "@graph-agent/core";
import { terminalResultHash, verifyResultBinding } from "../src/result-binding.js";

/**
 * Build a genuine AgentResult whose terminal event metadata carries the
 * result_hash produced by core's resultBindingHash over the result fields.
 * This mirrors how core's node writer binds a result to its event chain:
 * the hash is computed from the canonical result fields, then stuffed into
 * the terminal event's metadata via EventRecorder.record({ metadata }).
 */
function buildResult(overrides?: {
  output?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  staleHash?: string;
  dropResultHash?: boolean;
  noEvents?: boolean;
}): AgentResult {
  const nodeId = "node-1";
  const status = NodeStatus.COMPLETED;
  const output = overrides?.output ?? "hello";
  const inputTokens = overrides?.inputTokens ?? 10;
  const outputTokens = overrides?.outputTokens ?? 5;

  const resultHash = resultBindingHash({
    nodeId,
    status,
    output,
    inputTokens,
    outputTokens,
  });

  let events: readonly RunEvent[] = [];
  if (!overrides?.noEvents) {
    const recorder = new EventRecorder(nodeId, () => 0);
    recorder.record({ type: EventType.NODE_STARTED });
    const metadata = overrides?.dropResultHash
      ? {}
      : { result_hash: overrides?.staleHash ?? resultHash };
    recorder.record({ type: EventType.NODE_COMPLETED, metadata });
    events = recorder.events;
  }

  return createAgentResult({
    nodeId,
    status,
    output,
    usage: createUsage({ inputTokens, outputTokens }),
    events,
  });
}

describe("terminalResultHash", () => {
  it("返回终结事件 metadata 中的 result_hash", () => {
    const result = buildResult();
    const expected = resultBindingHash({
      nodeId: "node-1",
      status: NodeStatus.COMPLETED,
      output: "hello",
      inputTokens: 10,
      outputTokens: 5,
    });
    expect(terminalResultHash(result)).toBe(expected);
  });

  it("无事件时返回 null", () => {
    expect(terminalResultHash(buildResult({ noEvents: true }))).toBeNull();
  });

  it("缺少 result_hash 时返回 null", () => {
    expect(terminalResultHash(buildResult({ dropResultHash: true }))).toBeNull();
  });
});

describe("verifyResultBinding", () => {
  it("对完好的 result 返回 true", () => {
    expect(verifyResultBinding(buildResult())).toBe(true);
  });

  it("篡改 output 后返回 false", () => {
    // Terminal hash was bound to "hello"; rebuild with tampered output but stale hash.
    const genuineHash = resultBindingHash({
      nodeId: "node-1",
      status: NodeStatus.COMPLETED,
      output: "hello",
      inputTokens: 10,
      outputTokens: 5,
    });
    const tampered = buildResult({ output: "tampered", staleHash: genuineHash });
    expect(verifyResultBinding(tampered)).toBe(false);
  });

  it("篡改 usage token 后返回 false", () => {
    const genuineHash = resultBindingHash({
      nodeId: "node-1",
      status: NodeStatus.COMPLETED,
      output: "hello",
      inputTokens: 10,
      outputTokens: 5,
    });
    const tampered = buildResult({ inputTokens: 999, staleHash: genuineHash });
    expect(verifyResultBinding(tampered)).toBe(false);
  });

  it("无事件时返回 false(不抛错)", () => {
    expect(verifyResultBinding(buildResult({ noEvents: true }))).toBe(false);
  });

  it("缺少 result_hash 时返回 false(不抛错)", () => {
    expect(verifyResultBinding(buildResult({ dropResultHash: true }))).toBe(false);
  });
});
