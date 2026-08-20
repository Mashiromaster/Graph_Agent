import { describe, expect, it } from "vitest";
import {
  createAgentIdentity,
  createAgentInput,
  createNodeBudget,
  type AgentInput,
  type AgentResult,
} from "@graph-agent/core";
import { createControllerPolicy } from "../src/policy.js";
import { NodeState, RunStatus } from "../src/graph-models.js";
import { verifyControllerEventChain } from "../src/controller-events.js";
import type { AgentSpec, NodeFactory, NodeRunner } from "../src/runner.js";
import { GraphController } from "../src/controller.js";
import { completedResult, spawnProposal } from "./fixtures.js";

// ── stub factory/runner (controller-level structural tests never run a node) ──

const stubRunner: NodeRunner = {
  spec: { identity: {} as never, budget: {} as never },
  run: async (): Promise<AgentResult> => {
    throw new Error("stub runner should not be driven in this test");
  },
};

const stubFactory: NodeFactory = { create: () => stubRunner };

function rootSpec(
  nodeId: string,
  toolNames: readonly string[] = [],
): AgentSpec & { toolNames: readonly string[] } {
  return {
    identity: createAgentIdentity({ nodeId, name: "Root Agent", role: "root", generation: 0 }),
    budget: createNodeBudget({ maxTotalTokens: 1000 }),
    role: "root",
    toolNames,
  };
}

function rootInput(nodeId: string): AgentInput {
  return createAgentInput({ task: "root task", context: [], sessionId: nodeId });
}

function makeController(): GraphController {
  return new GraphController(stubFactory, createControllerPolicy());
}

// A runner that never resolves — used only to hold nodes RUNNING is not needed
// here; structural tests operate purely on state without driving supersteps.

describe("GraphController.createRun", () => {
  it("materializes a READY root, reserves min(budget, policy), and emits run_created + snapshot", async () => {
    const controller = makeController();
    const snap = await controller.createRun("run-1", rootSpec("root"), stubRunner, rootInput("root"));

    expect(snap.runId).toBe("run-1");
    expect(snap.status).toBe(RunStatus.RUNNING);
    expect(snap.nodes).toHaveLength(1);
    expect(snap.nodes[0]!.nodeId).toBe("root");
    expect(snap.nodes[0]!.state).toBe(NodeState.READY);
    // reserved = min(spec 1000, policy default 64000) = 1000
    expect(snap.budget.reservedTokens).toBe(1000);
    expect(snap.budget.committedTokens).toBe(0);
    expect(snap.pendingExecutions).toBe(1);
  });

  it("clamps the reservation to policy.maxTotalTokens when the spec asks for more", async () => {
    const controller = new GraphController(
      stubFactory,
      createControllerPolicy({ maxTotalTokens: 500 }),
    );
    const spec: AgentSpec & { toolNames: readonly string[] } = {
      identity: createAgentIdentity({ nodeId: "root", name: "Root", role: "root" }),
      budget: createNodeBudget({ maxTotalTokens: 100000 }),
      role: "root",
      toolNames: [],
    };
    const snap = await controller.createRun("run-1", spec, stubRunner, rootInput("root"));
    expect(snap.budget.reservedTokens).toBe(500);
  });

  it("rejects a duplicate runId", async () => {
    const controller = makeController();
    await controller.createRun("run-1", rootSpec("root"), stubRunner, rootInput("root"));
    await expect(
      controller.createRun("run-1", rootSpec("root"), stubRunner, rootInput("root")),
    ).rejects.toThrow(/already exists/);
  });

  it("event chain verifies after createRun", async () => {
    const controller = makeController();
    await controller.createRun("run-1", rootSpec("root"), stubRunner, rootInput("root"));
    const json = await controller.checkpoint("run-1");
    const events = JSON.parse(json).events;
    expect(verifyControllerEventChain(events)).toBe(true);
    expect(events[0].type).toBe("run_created");
    expect(events[1].type).toBe("snapshot");
  });
});

describe("GraphController.addDependency", () => {
  it("gates a READY target until its source SUCCEEDS; rejects cycles and non-READY targets", async () => {
    const factory: NodeFactory = {
      create: ({ spec }) => ({
        spec,
        run: async (): Promise<AgentResult> => completedResult(spec.identity.nodeId, 1, 1),
      }),
    };
    const rootRunner: NodeRunner = {
      spec: { identity: {} as never, budget: {} as never },
      run: async (): Promise<AgentResult> =>
        completedResult("root", 5, 5, [
          spawnProposal("sp-a", "root", 0, [], 0.25),
          spawnProposal("sp-b", "root", 0, [], 0.25),
        ]),
    };
    const controller = new GraphController(factory, createControllerPolicy());
    await controller.createRun("run-1", rootSpec("root"), rootRunner, rootInput("root"));
    // Step once: root SUCCEEDS, two children materialize READY.
    const afterSpawn = await controller.runSuperstep("run-1");
    const children = afterSpawn.nodes.filter((n) => n.parentNodeId === "root");
    expect(children).toHaveLength(2);
    const [childA, childB] = children.map((n) => n.nodeId).sort();

    // Add dependency childA -> childB (childB must wait for childA).
    const dep = await controller.addDependency("run-1", childA!, childB!);
    expect(dep.edges.some((e) => e.sourceNodeId === childA && e.targetNodeId === childB)).toBe(true);

    // Reverse edge childB -> childA would now cycle → rejected.
    await expect(controller.addDependency("run-1", childB!, childA!)).rejects.toThrow(/cycle/);
    // Non-existent target/source rejected.
    await expect(controller.addDependency("run-1", childA!, "missing")).rejects.toThrow(
      /unknown target/,
    );
    await expect(controller.addDependency("run-1", "missing", childA!)).rejects.toThrow(
      /unknown source/,
    );
    // root is SUCCEEDED (non-READY) → cannot be a dependency target.
    await expect(controller.addDependency("run-1", childA!, "root")).rejects.toThrow(
      /must be READY/,
    );

    // Drive to idle: the gate holds — both children eventually SUCCEED in order.
    const done = await controller.runUntilIdle("run-1");
    expect(done.status).toBe(RunStatus.SUCCEEDED);
    expect(done.nodes.every((n) => n.state === NodeState.SUCCEEDED)).toBe(true);
  });
});

describe("GraphController.cancel", () => {
  it("cancels a run between supersteps: status CANCELLED and reservations released", async () => {
    const controller = makeController();
    const created = await controller.createRun(
      "run-1",
      rootSpec("root"),
      stubRunner,
      rootInput("root"),
    );
    expect(created.budget.reservedTokens).toBe(1000);

    const snap = await controller.cancel("run-1");
    expect(snap.status).toBe(RunStatus.CANCELLED);
    expect(snap.nodes[0]!.state).toBe(NodeState.CANCELLED);
    expect(snap.budget.reservedTokens).toBe(0);
    expect(snap.budget.committedTokens).toBe(0); // released, not committed
    expect(snap.pendingExecutions).toBe(0);
  });
});
