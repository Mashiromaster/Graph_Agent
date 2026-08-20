import { describe, expect, it } from "vitest";
import {
  NodeStatus,
  createAgentInput,
  createContextPacket,
  createNodeError,
} from "../src/result.js";

describe("NodeStatus", () => {
  it("exposes completed and failed", () => {
    expect(NodeStatus.COMPLETED).toBe("completed");
    expect(NodeStatus.FAILED).toBe("failed");
  });
});

describe("createNodeError", () => {
  it("defaults retryable to false and freezes", () => {
    const e = createNodeError({ code: "E", message: "boom" });
    expect(e).toEqual({ code: "E", message: "boom", retryable: false });
    expect(Object.isFrozen(e)).toBe(true);
  });
  it("rejects empty code", () => {
    expect(() => createNodeError({ code: " ", message: "m" })).toThrow(RangeError);
  });
});

describe("createContextPacket", () => {
  it("applies defaults and freezes", () => {
    const c = createContextPacket({ sourceNodeId: "n1", content: "hi" });
    expect(c).toEqual({ sourceNodeId: "n1", content: "hi", trust: 1, edgeType: "message" });
    expect(Object.isFrozen(c)).toBe(true);
  });
  it("rejects trust outside [0,1]", () => {
    expect(() =>
      createContextPacket({ sourceNodeId: "n1", content: "hi", trust: 2 }),
    ).toThrow(RangeError);
  });
});

describe("createAgentInput", () => {
  it("defaults context/sessionId/metadata and freezes", () => {
    const i = createAgentInput({ task: "do it" });
    expect(i.task).toBe("do it");
    expect(i.context).toEqual([]);
    expect(i.sessionId).toBeNull();
    expect(i.metadata).toEqual({});
    expect(Object.isFrozen(i)).toBe(true);
    expect(Object.isFrozen(i.context)).toBe(true);
  });
  it("rejects empty task", () => {
    expect(() => createAgentInput({ task: "  " })).toThrow(RangeError);
  });
  it("rejects empty sessionId when provided", () => {
    expect(() => createAgentInput({ task: "t", sessionId: " " })).toThrow(RangeError);
  });
});
