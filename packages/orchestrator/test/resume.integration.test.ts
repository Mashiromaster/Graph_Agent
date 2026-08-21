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
  createNodeRecord,
  runSnapshotToDict,
} from "../src/graph-models.js";
import type { AgentSpec, NodeFactory, NodeRunner } from "../src/runner.js";
import { GraphController } from "../src/controller.js";
import { resumeController } from "../src/resume.js";
import { buildResumableCheckpoint } from "../src/checkpoint.js";
import { createMutableRunState, snapshotOf } from "../src/mutable-state.js";
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

/**
 * The checkpoint stores the orchestrator's opaque spec — which for these tests
 * IS the minimal orchestrator AgentSpec {identity, budget, role?, toolNames?}.
 * The web layer would pass node.agentSpecFromDict; here rehydrateSpec is a local
 * function that validates the plain dict carries the required shape and returns it.
 * It never imports @graph-agent/node.
 */
function rehydrateSpec(dict: unknown): AgentSpec {
  if (dict === null || typeof dict !== "object") {
    throw new TypeError("spec must be an object");
  }
  const record = dict as Record<string, unknown>;
  if (
    record["identity"] === null ||
    typeof record["identity"] !== "object" ||
    record["budget"] === null ||
    typeof record["budget"] !== "object"
  ) {
    throw new TypeError("spec must carry identity + budget");
  }
  return record as unknown as AgentSpec;
}

/**
 * A spy factory: records every nodeId passed to `create` and counts each
 * runner.run invocation per nodeId. Children complete trivially (genuine result).
 */
interface SpyFactory extends NodeFactory {
  readonly created: string[];
  readonly runCounts: Map<string, number>;
}

function spyFactory(): SpyFactory {
  const created: string[] = [];
  const runCounts = new Map<string, number>();
  return {
    created,
    runCounts,
    create: ({ spec }) => {
      const nodeId = spec.identity.nodeId;
      created.push(nodeId);
      return {
        spec,
        run: async (): Promise<AgentResult> => {
          runCounts.set(nodeId, (runCounts.get(nodeId) ?? 0) + 1);
          return completedResult(nodeId, 2, 2);
        },
      };
    },
  };
}

// Root runner that spawns one child and completes.
function rootRunnerSpawning(): NodeRunner {
  return {
    spec: { identity: {} as never, budget: {} as never },
    run: async (): Promise<AgentResult> =>
      completedResult("root", 5, 5, [spawnProposal("sp-1", "root", 0, [], 0.5)]),
  };
}

describe("resume: continues an interrupted run without re-running completed nodes", () => {
  it("Scenario A: replays the completed root from archive, runs only the pending child once", async () => {
    // Run ONE superstep: root completes + spawns child; child is READY but NOT run.
    const factory1 = spyFactory();
    const c1 = new GraphController(factory1, createControllerPolicy());
    await c1.createRun("run-1", rootSpec("root"), rootRunnerSpawning(), agentInput("root"));
    const afterOne = await c1.runSuperstep("run-1");

    // Preconditions: root SUCCEEDED, exactly one child READY (pending, not yet run).
    const root = afterOne.nodes.find((n) => n.nodeId === "root")!;
    expect(root.state).toBe(NodeState.SUCCEEDED);
    const child = afterOne.nodes.find((n) => n.parentNodeId === "root")!;
    expect(child).toBeDefined();
    expect(child.state).toBe(NodeState.READY);
    expect(afterOne.status).toBe(RunStatus.RUNNING);
    const committedAfterRoot = afterOne.budget.committedTokens; // root's 10 commit
    expect(committedAfterRoot).toBe(10);

    const json = await c1.checkpointResumable("run-1");

    // Resume into a fresh controller with a fresh spy factory.
    const factory2 = spyFactory();
    const c2 = resumeController(json, factory2, {
      policy: createControllerPolicy(),
      clock: () => 0,
      rehydrateSpec,
    });
    const final = await c2.runUntilIdle("run-1");

    // The completed ROOT must NOT be re-created or re-run (replayed from archive).
    expect(factory2.created).not.toContain("root");
    expect(factory2.runCounts.has("root")).toBe(false);

    // The pending child was created + run EXACTLY once.
    expect(factory2.created).toContain(child.nodeId);
    expect(factory2.runCounts.get(child.nodeId)).toBe(1);

    // Run converged.
    expect(final.status).toBe(RunStatus.SUCCEEDED);
    expect(final.nodes.every((n) => n.state === NodeState.SUCCEEDED)).toBe(true);
    expect(final.budget.reservedTokens).toBe(0);

    // Budget NOT double-counted: root's archived commit (10) + child's commit (4) = 14.
    // (If root had been re-run/re-charged it would be 20 + 4 = 24.)
    expect(final.budget.committedTokens).toBe(committedAfterRoot + 4);
    expect(final.budget.committedTokens).toBe(14);
  });

  it("Scenario B: a fully-complete single-node graph resumes idempotently (no work)", async () => {
    const factory1 = spyFactory();
    const c1 = new GraphController(factory1, createControllerPolicy());
    const rootRunner: NodeRunner = {
      spec: { identity: {} as never, budget: {} as never },
      run: async (): Promise<AgentResult> => completedResult("root", 5, 5),
    };
    await c1.createRun("run-1", rootSpec("root"), rootRunner, agentInput("root"));
    const converged = await c1.runUntilIdle("run-1");
    expect(converged.status).toBe(RunStatus.SUCCEEDED);

    const json = await c1.checkpointResumable("run-1");

    const factory2 = spyFactory();
    const c2 = resumeController(json, factory2, {
      policy: createControllerPolicy(),
      rehydrateSpec,
    });
    const final = await c2.runUntilIdle("run-1");

    // Nothing created, nothing run.
    expect(factory2.created).toHaveLength(0);
    expect(factory2.runCounts.size).toBe(0);
    // Snapshot unchanged (idempotent).
    expect(final.status).toBe(RunStatus.SUCCEEDED);
    expect(final.budget.committedTokens).toBe(converged.budget.committedTokens);
    expect(final.nodes.length).toBe(converged.nodes.length);
    expect(final.pendingExecutions).toBe(0);
  });

  it("Scenario C: a v1 checkpoint() JSON is rejected", async () => {
    const factory1 = spyFactory();
    const c1 = new GraphController(factory1, createControllerPolicy());
    const rootRunner: NodeRunner = {
      spec: { identity: {} as never, budget: {} as never },
      run: async (): Promise<AgentResult> => completedResult("root", 5, 5),
    };
    await c1.createRun("run-1", rootSpec("root"), rootRunner, agentInput("root"));
    await c1.runUntilIdle("run-1");

    const v1 = await c1.checkpoint("run-1");
    expect(() =>
      resumeController(v1, spyFactory(), {
        policy: createControllerPolicy(),
        rehydrateSpec,
      }),
    ).toThrow();
  });

  describe("Scenario D: fail-closed on tampering", () => {
    // Build a resumable checkpoint mid-flight (child READY, not run) once and reuse.
    async function midFlightCheckpoint(): Promise<string> {
      const c1 = new GraphController(spyFactory(), createControllerPolicy());
      await c1.createRun("run-1", rootSpec("root"), rootRunnerSpawning(), agentInput("root"));
      await c1.runSuperstep("run-1");
      return c1.checkpointResumable("run-1");
    }

    function tamper(json: string, mutate: (root: Record<string, unknown>) => void): string {
      const root = JSON.parse(json) as Record<string, unknown>;
      mutate(root);
      return JSON.stringify(root);
    }

    it("rejects when Σ(pending reservation) != budget.reservedTokens", async () => {
      const json = await midFlightCheckpoint();
      const tampered = tamper(json, (root) => {
        const resumable = root["resumable"] as Record<string, unknown>;
        const nodes = resumable["nodes"] as Array<Record<string, unknown>>;
        for (const node of nodes) {
          if (node["state"] === NodeState.READY) {
            node["reservation"] = (node["reservation"] as number) + 999;
          }
        }
      });
      expect(() =>
        resumeController(tampered, spyFactory(), {
          policy: createControllerPolicy(),
          rehydrateSpec,
        }),
      ).toThrow();
    });

    it("rejects when an archivedResults nodeId is not in the snapshot nodes", async () => {
      const json = await midFlightCheckpoint();
      const tampered = tamper(json, (root) => {
        const resumable = root["resumable"] as Record<string, unknown>;
        const archived = resumable["archivedResults"] as Array<Record<string, unknown>>;
        for (const entry of archived) {
          entry["nodeId"] = "ghost-node";
        }
      });
      expect(() =>
        resumeController(tampered, spyFactory(), {
          policy: createControllerPolicy(),
          rehydrateSpec,
        }),
      ).toThrow();
    });

    it("propagates when rehydrateSpec throws on a node (no half-built controller)", async () => {
      const json = await midFlightCheckpoint();
      const throwingRehydrate = (dict: unknown): AgentSpec => {
        void dict;
        throw new Error("cannot rehydrate spec");
      };
      expect(() =>
        resumeController(json, spyFactory(), {
          policy: createControllerPolicy(),
          rehydrateSpec: throwingRehydrate,
        }),
      ).toThrow(/cannot rehydrate spec/);
    });
  });
});

/**
 * Scenario E: the interrupted RUNNING → READY reset path.
 *
 * APPROACH: the scheduler always settles every claim within a single superstep
 * (claim → RUNNING → settle all happen inside runSuperstepInner), so a node can
 * never be observed in RUNNING state at a public checkpointResumable boundary.
 * Producing a valid v2 checkpoint carrying a RUNNING node through the public API
 * is therefore genuinely impossible. Per the brief's fallback, we build the
 * checkpoint directly via buildResumableCheckpoint from a MutableRunState we
 * construct with one node RUNNING (a genuine interrupted mid-flight state: its
 * reservation is held, no archived result exists for it), a valid event chain
 * (run_created + snapshot), then resume and assert it re-runs. This mirrors the
 * direct-state construction pattern already used in checkpoint-v2.test.ts.
 */
describe("resume: interrupted RUNNING node is reset to READY and re-run", () => {
  it("Scenario E: a RUNNING node in the checkpoint is rebuilt as READY, created + run once", () => {
    const policy = createControllerPolicy();
    const runId = "run-interrupted";
    const reservation = 30;

    // Build a MutableRunState with a single RUNNING node holding its reservation.
    const state: MutableRunState = createMutableRunState(runId, policy);
    state.status = RunStatus.RUNNING;
    state.nodes.set(
      "root",
      createNodeRecord({
        nodeId: "root",
        name: "Root",
        role: "root",
        parentNodeId: null,
        generation: 0,
        priority: 0.5,
        state: NodeState.RUNNING, // interrupted mid-flight
        allowedToolNames: [],
        allocationTokens: reservation,
      }),
    );
    state.specs.set("root", rootSpec("root"));
    state.inputs.set("root", agentInput("root"));
    state.nodeReservations.set("root", reservation);
    state.reservedTokens = reservation;
    // No archived result for the RUNNING node (it never completed).

    // Valid event chain: run_created + snapshot of the (RUNNING) state.
    let events: ControllerEvent[] = appendControllerEvent([], runId, "run_created", {});
    events = appendControllerEvent(events, runId, "snapshot", {
      snapshot: runSnapshotToDict(snapshotOf(state)),
    });

    const json = buildResumableCheckpoint(state, events);

    // Resume with a fresh spy factory.
    const factory = spyFactory();
    const c = resumeController(json, factory, { policy, clock: () => 0, rehydrateSpec });

    return c.runUntilIdle(runId).then((final) => {
      // The RUNNING node was reset to READY → the factory created + ran it once.
      // (If it had been treated as completed, it would be neither created nor run.)
      expect(factory.created).toContain("root");
      expect(factory.runCounts.get("root")).toBe(1);

      // Run converged; the re-run committed the node's usage, reservation cleared.
      expect(final.status).toBe(RunStatus.SUCCEEDED);
      expect(final.nodes.every((n) => n.state === NodeState.SUCCEEDED)).toBe(true);
      expect(final.budget.reservedTokens).toBe(0);
      // completedResult("root", 2, 2) commits 4 tokens on the re-run.
      expect(final.budget.committedTokens).toBe(4);
      expect(final.pendingExecutions).toBe(0);
    });
  });
});
