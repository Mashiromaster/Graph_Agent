import { describe, expect, it } from "vitest";
import {
  agentResultFromDict,
  createAgentIdentity,
  createNodeBudget,
  type AgentResult,
} from "@graph-agent/core";
import { createControllerPolicy } from "../src/policy.js";
import { RunStatus } from "../src/graph-models.js";
import type { AgentSpec, NodeFactory, NodeRunner } from "../src/runner.js";
import { GraphController } from "../src/controller.js";
import {
  buildResumableCheckpoint,
  parseResumableCheckpoint,
} from "../src/checkpoint.js";
import { createMutableRunState, snapshotOf } from "../src/mutable-state.js";
import {
  ingestLocked,
  freezeFrontierAndClaim,
} from "../src/scheduler.js";
import { appendControllerEvent, type ControllerEvent } from "../src/controller-events.js";
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

async function convergedController(): Promise<GraphController> {
  const controller = new GraphController(completingFactory, createControllerPolicy());
  await controller.createRun("run-1", rootSpec("root"), rootRunner, agentInput("root"));
  await controller.runUntilIdle("run-1");
  return controller;
}

describe("v2 resumable checkpoint", () => {
  it("checkpointResumable → parse round-trips nodes/input/reservation/state + archived results", async () => {
    const controller = await convergedController();
    const json = await controller.checkpointResumable("run-1");
    const parsed = parseResumableCheckpoint(json);

    // finalSnapshot matches the pure v1 replay of the same events.
    const live = GraphController.replay(controller.events("run-1"));
    expect(parsed.finalSnapshot.runId).toBe(live.runId);
    expect(parsed.finalSnapshot.status).toBe(RunStatus.SUCCEEDED);
    expect(parsed.finalSnapshot.nodes.length).toBe(live.nodes.length);

    // resumable.nodes covers every node with spec/input/toolNames/reservation/state.
    const snapshotNodeIds = live.nodes.map((n) => n.nodeId).sort();
    const resumableNodeIds = parsed.resumable.nodes.map((n) => n.nodeId).sort();
    expect(resumableNodeIds).toEqual(snapshotNodeIds);
    for (const node of parsed.resumable.nodes) {
      expect(typeof node.state).toBe("string");
      expect(Array.isArray(node.toolNames)).toBe(true);
      expect(typeof node.reservation).toBe("number");
      expect(node.spec).toBeTypeOf("object");
      expect(node.input).toBeTypeOf("object");
    }

    // archivedResults contains completed executions; each rebuildable via core dict.
    expect(parsed.resumable.archivedResults.length).toBeGreaterThan(0);
    for (const archived of parsed.resumable.archivedResults) {
      const result = agentResultFromDict(archived.result);
      expect(result.nodeId).toBe(archived.nodeId);
      expect(typeof archived.executionId).toBe("string");
    }
    expect(typeof parsed.resumable.enqueueSequence).toBe("number");
  });

  it("old checkpoint() still returns a 6-key v1 doc without resumable", async () => {
    const controller = await convergedController();
    const v1 = await controller.checkpoint("run-1");
    const parsedV1 = JSON.parse(v1) as Record<string, unknown>;
    expect(Object.keys(parsedV1).sort()).toEqual([
      "chainHead",
      "eventCount",
      "events",
      "runId",
      "schemaVersion",
      "stateDigest",
    ]);
    expect(parsedV1["schemaVersion"]).toBe(1);
    expect(parsedV1["resumable"]).toBeUndefined();
  });

  it("parseResumableCheckpoint rejects a v1 checkpoint", async () => {
    const controller = await convergedController();
    const v1 = await controller.checkpoint("run-1");
    expect(() => parseResumableCheckpoint(v1)).toThrow();
  });

  it("adoptRun injects a run whose events are then readable", async () => {
    const controller = await convergedController();
    const source = controller.events("run-1");
    // Reconstruct an independent state + events pair and adopt under a new id.
    const state = createMutableRunState("adopted-run", createControllerPolicy());
    const events: ControllerEvent[] = appendControllerEvent([], "adopted-run", "run_created", {});
    controller.adoptRun("adopted-run", state, events);
    expect(controller.events("adopted-run").length).toBe(1);
    expect(() => controller.adoptRun("adopted-run", state, events)).toThrow();
    void source;
  });

  it("archives an AgentResult on ingest of a completed execution", async () => {
    const state = createMutableRunState("s", createControllerPolicy());
    const spec = rootSpec("root");
    state.nodes.set(
      "root",
      // minimal READY node
      (await import("../src/graph-models.js")).createNodeRecord({
        nodeId: "root",
        name: "Root",
        role: "root",
        parentNodeId: null,
        generation: 0,
        priority: 0.5,
        state: (await import("../src/graph-models.js")).NodeState.READY,
        allowedToolNames: [],
        allocationTokens: 20,
      }),
    );
    state.specs.set("root", spec);
    state.inputs.set("root", agentInput("root"));
    state.nodeReservations.set("root", 20);
    state.reservedTokens += 20;

    const claims = freezeFrontierAndClaim(state);
    expect(claims.length).toBe(1);
    const claim = claims[0]!;
    const result = completedResult("root", 5, 5);
    const events: ControllerEvent[] = [];
    let chain: ControllerEvent[] = appendControllerEvent(events, "s", "run_created", {});
    const append = (type: Parameters<typeof appendControllerEvent>[2], detail: object): void => {
      chain = appendControllerEvent(chain, "s", type, detail);
    };
    ingestLocked(state, claim.execution, claim.node, result, append, completingFactory);
    expect(state.archivedResults.has(claim.execution.executionId)).toBe(true);
    expect(state.archivedResults.get(claim.execution.executionId)!.nodeId).toBe("root");
    void buildResumableCheckpoint;
    void snapshotOf;
  });
});
