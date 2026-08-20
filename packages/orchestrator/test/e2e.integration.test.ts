import { describe, expect, it } from "vitest";
import {
  createAgentIdentity,
  createNodeBudget,
  type AgentResult,
} from "@graph-agent/core";
import { createControllerPolicy } from "../src/policy.js";
import {
  NodeState,
  RunStatus,
  runSnapshotToDict,
  type RunSnapshot,
} from "../src/graph-models.js";
import type { AgentSpec, NodeFactory, NodeRunner } from "../src/runner.js";
import { GraphController } from "../src/controller.js";
import { completedResult, spawnProposal, wrongNodeResult, agentInput } from "./fixtures.js";

function rootSpec(nodeId: string, toolNames: readonly string[] = []): AgentSpec & {
  toolNames: readonly string[];
} {
  return {
    identity: createAgentIdentity({ nodeId, name: "Root", role: "root", generation: 0 }),
    budget: createNodeBudget({ maxTotalTokens: 1000 }),
    role: "root",
    toolNames,
  };
}

/** A factory whose children complete trivially with a small usage. */
const trivialChildFactory: NodeFactory = {
  create: ({ spec }) => ({
    spec,
    run: async (): Promise<AgentResult> => completedResult(spec.identity.nodeId, 2, 2),
  }),
};

// ── end-to-end multi-generation spawn ────────────────────────────────────────

describe("e2e: multi-generation spawn convergence", () => {
  it("root spawns a child; runUntilIdle converges with both SUCCEEDED and budget consistent", async () => {
    const rootRunner: NodeRunner = {
      spec: { identity: {} as never, budget: {} as never },
      run: async (): Promise<AgentResult> =>
        completedResult("root", 10, 10, [spawnProposal("sp-1", "root", 0, [], 0.5)]),
    };
    const controller = new GraphController(trivialChildFactory, createControllerPolicy());
    await controller.createRun("run-1", rootSpec("root"), rootRunner, agentInput("root"));

    const final = await controller.runUntilIdle("run-1");

    expect(final.status).toBe(RunStatus.SUCCEEDED);
    expect(final.nodes).toHaveLength(2);
    expect(final.nodes.every((n) => n.state === NodeState.SUCCEEDED)).toBe(true);
    const child = final.nodes.find((n) => n.parentNodeId === "root");
    expect(child).toBeDefined();
    // budget: committed <= limit, reserved 0 at end.
    expect(final.budget.reservedTokens).toBe(0);
    expect(final.budget.committedTokens).toBeLessThanOrEqual(final.budget.limitTokens);
    // root usage 20 committed; child usage 4 committed → 24 total.
    expect(final.budget.committedTokens).toBe(24);
    expect(final.pendingExecutions).toBe(0);
  });
});

// ── merge determinism (sequence-based, not completion order) ─────────────────

describe("e2e: merge determinism under out-of-order completion", () => {
  /**
   * Build a controller whose root spawns TWO children. The two child runners
   * complete out of order: `delayedChildId` resolves after a macrotask, the
   * other resolves immediately. The final snapshot must be byte-identical
   * regardless of which child is delayed.
   */
  async function runWithDelay(delayedChildRole: "first" | "second"): Promise<RunSnapshot> {
    let materialized: string[] = [];
    const factory: NodeFactory = {
      create: ({ spec }) => {
        const nodeId = spec.identity.nodeId;
        materialized.push(nodeId);
        // Deterministically pick which materialized child to delay: the two
        // children materialize in a fixed order (spawn ordinal). We delay the
        // 1st or 2nd materialized child based on the parameter.
        const isFirst = materialized.length === 1;
        const shouldDelay =
          (delayedChildRole === "first" && isFirst) ||
          (delayedChildRole === "second" && !isFirst);
        return {
          spec,
          run: async (): Promise<AgentResult> => {
            if (shouldDelay) {
              // Yield across several macrotasks so this resolves AFTER the sibling.
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            return completedResult(nodeId, 3, 3);
          },
        };
      },
    };
    const rootRunner: NodeRunner = {
      spec: { identity: {} as never, budget: {} as never },
      run: async (): Promise<AgentResult> =>
        completedResult("root", 5, 5, [
          spawnProposal("sp-a", "root", 0, [], 0.25),
          spawnProposal("sp-b", "root", 0, [], 0.25),
        ]),
    };
    const controller = new GraphController(factory, createControllerPolicy({ maxConcurrency: 4 }));
    await controller.createRun("run-1", rootSpec("root"), rootRunner, agentInput("root"));
    return controller.runUntilIdle("run-1");
  }

  it("produces an identical final snapshot regardless of completion order", async () => {
    const a = await runWithDelay("first");
    const b = await runWithDelay("second");
    expect(a.status).toBe(RunStatus.SUCCEEDED);
    // Deep-equal the full serialized snapshots (nodes/edges/decisions/budget).
    expect(runSnapshotToDict(a)).toEqual(runSnapshotToDict(b));
  });
});

// ── fail-closed (invalid result) ─────────────────────────────────────────────

describe("e2e: fail-closed on an invalid runner result", () => {
  it("a wrong-nodeId result FAILS the node, commits the full reservation, materializes no child", async () => {
    const rootRunner: NodeRunner = {
      spec: { identity: {} as never, budget: {} as never },
      // Returns a genuine result but for the WRONG node id → SOURCE_MISMATCH.
      run: async (): Promise<AgentResult> => wrongNodeResult("root", "impostor"),
    };
    const controller = new GraphController(trivialChildFactory, createControllerPolicy());
    await controller.createRun("run-1", rootSpec("root"), rootRunner, agentInput("root"));

    const final = await controller.runUntilIdle("run-1");

    expect(final.status).toBe(RunStatus.FAILED);
    expect(final.nodes).toHaveLength(1); // no child materialized
    expect(final.nodes[0]!.state).toBe(NodeState.FAILED);
    // full reservation (1000) committed, none left reserved.
    expect(final.budget.committedTokens).toBe(1000);
    expect(final.budget.reservedTokens).toBe(0);
    expect(final.pendingExecutions).toBe(0);
  });
});

// ── cancel between supersteps releases reservations ──────────────────────────

describe("e2e: cancel between supersteps", () => {
  it("cancel releases the root reservation without committing it", async () => {
    const rootRunner: NodeRunner = {
      spec: { identity: {} as never, budget: {} as never },
      run: async (): Promise<AgentResult> => completedResult("root", 1, 1),
    };
    const controller = new GraphController(trivialChildFactory, createControllerPolicy());
    const created = await controller.createRun(
      "run-1",
      rootSpec("root"),
      rootRunner,
      agentInput("root"),
    );
    expect(created.budget.reservedTokens).toBe(1000);

    const cancelled = await controller.cancel("run-1");
    expect(cancelled.status).toBe(RunStatus.CANCELLED);
    expect(cancelled.budget.reservedTokens).toBe(0);
    expect(cancelled.budget.committedTokens).toBe(0);

    // A subsequent superstep is a no-op (run is no longer RUNNING).
    const after = await controller.runSuperstep("run-1");
    expect(after.status).toBe(RunStatus.CANCELLED);
  });
});
