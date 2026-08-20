import { describe, expect, it } from "vitest";
import {
  EventRecorder,
  EventType,
  GENESIS_HASH,
  resultBindingHash,
  verifyEventChain,
  type RunEvent,
} from "../src/events.js";

function fixedClock(): () => number {
  let t = 1000;
  return () => (t += 1);
}

describe("EventRecorder", () => {
  it("chains events from genesis", () => {
    const rec = new EventRecorder("n1", fixedClock());
    const first = rec.record({ type: EventType.NODE_STARTED });
    const second = rec.record({ type: EventType.NODE_COMPLETED, outputValue: "done" });
    expect(first.sequence).toBe(0);
    expect(first.previousHash).toBe(GENESIS_HASH);
    expect(second.sequence).toBe(1);
    expect(second.previousHash).toBe(first.eventHash);
    expect(rec.events).toHaveLength(2);
    expect(Object.isFrozen(rec.events[0])).toBe(true);
  });

  it("produces a valid chain", () => {
    const rec = new EventRecorder("n1", fixedClock());
    rec.record({ type: EventType.NODE_STARTED });
    rec.record({ type: EventType.NODE_COMPLETED });
    expect(verifyEventChain(rec.events)).toBe(true);
  });
});

describe("verifyEventChain", () => {
  it("accepts an empty chain", () => {
    expect(verifyEventChain([])).toBe(true);
  });

  it("detects a tampered field", () => {
    const rec = new EventRecorder("n1", fixedClock());
    rec.record({ type: EventType.NODE_STARTED });
    const events = [...rec.events];
    events[0] = { ...events[0]!, nodeId: "evil" };
    expect(verifyEventChain(events)).toBe(false);
  });

  it("detects a broken link", () => {
    const rec = new EventRecorder("n1", fixedClock());
    rec.record({ type: EventType.NODE_STARTED });
    rec.record({ type: EventType.NODE_COMPLETED });
    const events = [...rec.events];
    events[1] = { ...events[1]!, previousHash: GENESIS_HASH };
    expect(verifyEventChain(events)).toBe(false);
  });

  it("detects a forged eventHash", () => {
    const rec = new EventRecorder("n1", fixedClock());
    rec.record({ type: EventType.NODE_STARTED });
    const events = [...rec.events];
    events[0] = { ...events[0]!, eventHash: "f".repeat(64) };
    expect(verifyEventChain(events)).toBe(false);
  });

  it("detects an out-of-order sequence", () => {
    const rec = new EventRecorder("n1", fixedClock());
    rec.record({ type: EventType.NODE_STARTED });
    rec.record({ type: EventType.NODE_COMPLETED });
    expect(verifyEventChain([rec.events[1]!, rec.events[0]!])).toBe(false);
  });

  const tamperCases: Array<{ field: keyof RunEvent; value: RunEvent[keyof RunEvent] }> = [
    { field: "timestamp", value: 999999 },
    { field: "type", value: EventType.NODE_FAILED },
    { field: "inputHash", value: "a".repeat(64) },
    { field: "outputHash", value: "b".repeat(64) },
    { field: "metadataJson", value: '{"tampered":true}' },
  ];

  for (const { field, value } of tamperCases) {
    it(`detects a tampered ${field}`, () => {
      const rec = new EventRecorder("n1", fixedClock());
      rec.record({
        type: EventType.NODE_COMPLETED,
        inputValue: "in",
        outputValue: "out",
        metadata: { k: "v" },
      });
      const events = [...rec.events];
      events[0] = { ...events[0]!, [field]: value } as RunEvent;
      expect(verifyEventChain(events)).toBe(false);
    });
  }
});

describe("resultBindingHash", () => {
  it("is stable for identical inputs", () => {
    const base = {
      nodeId: "n1",
      status: "completed",
      output: "ok",
      inputTokens: 1,
      outputTokens: 2,
    };
    expect(resultBindingHash(base)).toBe(resultBindingHash({ ...base }));
  });

  it("changes when output changes", () => {
    const base = {
      nodeId: "n1",
      status: "completed",
      output: "ok",
      inputTokens: 1,
      outputTokens: 2,
    };
    expect(resultBindingHash(base)).not.toBe(
      resultBindingHash({ ...base, output: "different" }),
    );
  });
});
