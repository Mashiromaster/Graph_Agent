import { describe, expect, it } from "vitest";
import {
  CONTROLLER_GENESIS_HASH,
  appendControllerEvent,
  controllerEventDetail,
  createControllerEvent,
  verifyControllerEventChain,
} from "../src/controller-events.js";
import type { ControllerEvent } from "../src/controller-events.js";

const RUN_ID = "run-1";

describe("controller event chain", () => {
  it("appends two events from genesis with correct linkage", () => {
    let chain: ControllerEvent[] = [];
    chain = appendControllerEvent(chain, RUN_ID, "run_created", {});
    chain = appendControllerEvent(chain, RUN_ID, "snapshot", { snapshot: { nodes: [] } });

    expect(chain[0]!.sequence).toBe(0);
    expect(chain[0]!.previousHash).toBe(CONTROLLER_GENESIS_HASH);
    expect(chain[1]!.sequence).toBe(1);
    expect(chain[1]!.previousHash).toBe(chain[0]!.eventHash);
  });

  it("verifies a valid chain", () => {
    let chain: ControllerEvent[] = [];
    chain = appendControllerEvent(chain, RUN_ID, "run_created", {});
    chain = appendControllerEvent(chain, RUN_ID, "snapshot", { snapshot: {} });
    expect(verifyControllerEventChain(chain)).toBe(true);
  });

  it("empty chain fails verification", () => {
    expect(verifyControllerEventChain([])).toBe(false);
  });

  it("detects tampered detailJson", () => {
    let chain: ControllerEvent[] = [];
    chain = appendControllerEvent(chain, RUN_ID, "run_created", {});
    chain = appendControllerEvent(chain, RUN_ID, "snapshot", { snapshot: {} });
    const tampered = [...chain];
    tampered[1] = { ...chain[1]!, detailJson: '{"snapshot":{"hacked":true}}' };
    expect(verifyControllerEventChain(tampered)).toBe(false);
  });

  it("detects tampered eventHash", () => {
    let chain: ControllerEvent[] = [];
    chain = appendControllerEvent(chain, RUN_ID, "run_created", {});
    const tampered = [...chain];
    tampered[0] = { ...chain[0]!, eventHash: "f".repeat(64) };
    expect(verifyControllerEventChain(tampered)).toBe(false);
  });

  it("detects out-of-order sequence", () => {
    let chain: ControllerEvent[] = [];
    chain = appendControllerEvent(chain, RUN_ID, "run_created", {});
    chain = appendControllerEvent(chain, RUN_ID, "snapshot", {});
    const swapped = [chain[1]!, chain[0]!];
    expect(verifyControllerEventChain(swapped)).toBe(false);
  });

  it("detects a different runId mid-chain", () => {
    let chain: ControllerEvent[] = [];
    chain = appendControllerEvent(chain, RUN_ID, "run_created", {});
    chain = appendControllerEvent(chain, RUN_ID, "snapshot", {});
    const tampered = [...chain];
    tampered[1] = { ...chain[1]!, runId: "run-2" };
    expect(verifyControllerEventChain(tampered)).toBe(false);
  });

  it("builds and verifies a chain of all four event types", () => {
    let chain: ControllerEvent[] = [];
    chain = appendControllerEvent(chain, RUN_ID, "run_created", {});
    chain = appendControllerEvent(chain, RUN_ID, "snapshot", {
      snapshot: { runId: RUN_ID, nodes: [] },
    });
    chain = appendControllerEvent(chain, RUN_ID, "dependency_added", {
      sourceNodeId: "a",
      targetNodeId: "b",
    });
    chain = appendControllerEvent(chain, RUN_ID, "execution_settled", {
      nodeId: "a",
      state: "completed",
      code: 0,
    });

    expect(chain.map((e) => e.type)).toEqual([
      "run_created",
      "snapshot",
      "dependency_added",
      "execution_settled",
    ]);
    expect(verifyControllerEventChain(chain)).toBe(true);
  });

  it("controllerEventDetail returns the parsed detail object", () => {
    const event = createControllerEvent(
      0,
      RUN_ID,
      "dependency_added",
      { sourceNodeId: "a", targetNodeId: "b" },
      CONTROLLER_GENESIS_HASH,
    );
    expect(controllerEventDetail(event)).toEqual({
      sourceNodeId: "a",
      targetNodeId: "b",
    });
  });

  it("rejects duplicate keys in detailJson", () => {
    const good = createControllerEvent(0, RUN_ID, "run_created", {}, CONTROLLER_GENESIS_HASH);
    const dupKey: ControllerEvent = { ...good, detailJson: '{"a":1,"a":2}' };
    // controllerEventDetail must reject the dup-key JSON.
    expect(() => controllerEventDetail(dupKey)).toThrow();
    // ...and a chain containing it must fail verification (never throws).
    expect(verifyControllerEventChain([dupKey])).toBe(false);
  });
});
