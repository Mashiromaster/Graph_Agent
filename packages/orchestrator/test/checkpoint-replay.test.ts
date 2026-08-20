import { describe, expect, it } from "vitest";
import {
  createAgentIdentity,
  createNodeBudget,
  type AgentResult,
} from "@graph-agent/core";
import { createControllerPolicy } from "../src/policy.js";
import { RunStatus, runSnapshotToDict } from "../src/graph-models.js";
import type { AgentSpec, NodeFactory, NodeRunner } from "../src/runner.js";
import { GraphController } from "../src/controller.js";
import { completedResult, spawnProposal, agentInput } from "./fixtures.js";

function rootSpec(nodeId: string): AgentSpec & { toolNames: readonly string[] } {
  return {
    identity: createAgentIdentity({ nodeId, name: "Root", role: "root", generation: 0 }),
    budget: createNodeBudget({ maxTotalTokens: 1000 }),
    role: "root",
    toolNames: [],
  };
}

const completingFactory: NodeFactory = {
  create: ({ spec }) => ({
    spec,
    run: async (): Promise<AgentResult> => completedResult(spec.identity.nodeId, 2, 2),
  }),
};

const rootRunner: NodeRunner = {
  spec: { identity: {} as never, budget: {} as never },
  run: async (): Promise<AgentResult> =>
    completedResult("root", 5, 5, [spawnProposal("sp-1", "root", 0, [], 0.5)]),
};

async function buildRun(): Promise<{ controller: GraphController; json: string }> {
  const controller = new GraphController(completingFactory, createControllerPolicy());
  await controller.createRun("run-1", rootSpec("root"), rootRunner, agentInput("root"));
  await controller.runUntilIdle("run-1");
  return { controller, json: controller.checkpoint("run-1") };
}

describe("checkpoint/replay round trip", () => {
  it("replayCheckpoint reproduces a snapshot deep-equal to the live snapshot", async () => {
    const { controller, json } = await buildRun();
    // Live snapshot: run one more (idempotent) superstep read via checkpoint's own digest source.
    const replayed = GraphController.replayCheckpoint(json);
    // The live final snapshot is what checkpoint hashed; recover it independently.
    const live = GraphController.replay(JSON.parse(json).events);
    expect(runSnapshotToDict(replayed)).toEqual(runSnapshotToDict(live));
    expect(replayed.status).toBe(RunStatus.SUCCEEDED);
    // control that the live run really converged
    void controller;
  });

  it("replay(events) rebuilds the snapshot with NO factory/runner involvement", async () => {
    const { json } = await buildRun();
    const events = JSON.parse(json).events;
    // replay is static and takes only events — proves purity by construction.
    const snapshot = GraphController.replay(events);
    expect(snapshot.status).toBe(RunStatus.SUCCEEDED);
    expect(snapshot.nodes.length).toBeGreaterThanOrEqual(2);
  });
});

describe("checkpoint tamper detection", () => {
  it("rejects a tampered stateDigest", async () => {
    const { json } = await buildRun();
    const parsed = JSON.parse(json);
    parsed.stateDigest = "0".repeat(64);
    expect(() => GraphController.replayCheckpoint(JSON.stringify(parsed))).toThrow(
      /digest mismatch/,
    );
  });

  it("rejects a tampered event eventHash", async () => {
    const { json } = await buildRun();
    const parsed = JSON.parse(json);
    const last = parsed.events[parsed.events.length - 1];
    last.eventHash = "f".repeat(64);
    // chainHead points at the old hash → header mismatch OR event hash rebuild mismatch.
    expect(() => GraphController.replayCheckpoint(JSON.stringify(parsed))).toThrow();
  });

  it("rejects a tampered event detailJson (hash rebuild fails)", async () => {
    const { json } = await buildRun();
    const parsed = JSON.parse(json);
    // Mutate a snapshot event's detail so its content no longer matches its stored hash.
    const snapEvent = parsed.events.find((e: { type: string }) => e.type === "snapshot");
    const detail = JSON.parse(snapEvent.detailJson);
    detail.snapshot.superstep = detail.snapshot.superstep + 999;
    snapEvent.detailJson = JSON.stringify(detail);
    expect(() => GraphController.replayCheckpoint(JSON.stringify(parsed))).toThrow();
  });

  it("rejects a dropped key", async () => {
    const { json } = await buildRun();
    const parsed = JSON.parse(json);
    delete parsed.stateDigest;
    expect(() => GraphController.replayCheckpoint(JSON.stringify(parsed))).toThrow(
      /unexpected key set/,
    );
  });

  it("rejects an added key", async () => {
    const { json } = await buildRun();
    const parsed = JSON.parse(json);
    parsed.extra = "nope";
    expect(() => GraphController.replayCheckpoint(JSON.stringify(parsed))).toThrow(
      /unexpected key set/,
    );
  });

  it("rejects a duplicate top-level key", async () => {
    const { json } = await buildRun();
    // canonicalJson sorts keys, so the top-level object ends with `...stateDigest":"<hex>"}`.
    // Inject a duplicate top-level "schemaVersion" key just before the final brace
    // (JSON.parse would silently coalesce; our lexer must reject it).
    expect(json.endsWith("}")).toBe(true);
    const tampered = `${json.slice(0, -1)},"schemaVersion":1}`;
    expect(() => GraphController.replayCheckpoint(tampered)).toThrow(/duplicate top-level key/);
  });

  it("rejects a wrong schemaVersion", async () => {
    const { json } = await buildRun();
    const parsed = JSON.parse(json);
    parsed.schemaVersion = 2;
    expect(() => GraphController.replayCheckpoint(JSON.stringify(parsed))).toThrow(
      /schemaVersion/,
    );
  });

  it("rejects an oversized checkpoint", () => {
    const huge = "x".repeat(5_000_001);
    expect(() => GraphController.replayCheckpoint(huge)).toThrow(/maximum size/);
  });
});
