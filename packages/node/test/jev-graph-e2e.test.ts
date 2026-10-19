/**
 * End-to-end: a heterogeneous graph where an LLM orchestrator spawns a Jev
 * decision node, dispatched by modelKind through ModelKindRegistry.
 *
 * This is the integration the two layers exist for. It proves the Jev node is a
 * first-class graph citizen: the controller approves the spawn, materializes it
 * via the registry, drives it to completion, and the resulting chain verifies —
 * all without the controller knowing Jev is not a chat model.
 */

import { describe, expect, it } from "vitest";
import {
  createAgentIdentity,
  createAgentInput,
  createNodeBudget,
} from "@graph-agent/core";
import type { JevDecision, JevQuestion } from "@graph-agent/adapter";
import { ScriptedModel, createModelResponse, createToolCall } from "@graph-agent/adapter";
import {
  GraphController,
  ModelKindRegistry,
  RunStatus,
  createControllerPolicy,
  verifyControllerEventChain,
  type AgentSpec as OrchestratorAgentSpec,
} from "@graph-agent/orchestrator";
import { AgentNode } from "../src/agent-node.js";
import { JevNode, type JevDecider } from "../src/jev-node.js";
import { SPAWN_TOOL } from "../src/graph-tools.js";
import { createAgentSpec, type AgentSpec } from "../src/spec.js";

const ROUTE_QUESTIONS: Readonly<Record<string, JevQuestion>> = {
  route: {
    type: "choice",
    instructions: "Which team should own this ticket?",
    criteria: { billing: "payments and refunds", technical: "outages and bugs" },
  },
  urgent: { type: "noul", instructions: "Does this need attention today?" },
};

const DECISION: JevDecision = Object.freeze({
  model: "jev-1.13.0",
  answers: Object.freeze({
    route: {
      type: "choice" as const,
      choice: "technical",
      noul: null,
      score: null,
      probabilities: { billing: 0.06, technical: 0.94 },
      confidence: 0.88,
      legend: null,
    },
    urgent: {
      type: "noul" as const,
      choice: null,
      noul: 0.96,
      score: null,
      probabilities: {},
      confidence: null,
      legend: null,
    },
  }),
  inputTokens: 210,
  outputTokens: 24,
});

class StubDecider implements JevDecider {
  calls = 0;
  async decide(): Promise<JevDecision> {
    this.calls += 1;
    return DECISION;
  }
}

/** Promote the controller's minimal spec to a full node spec. */
function toNodeSpec(spec: OrchestratorAgentSpec, allowedModelKinds: readonly string[]): AgentSpec {
  return createAgentSpec({
    identity: spec.identity,
    budget: spec.budget,
    instructions: `You are the ${spec.role ?? spec.identity.role}.`,
    ...(spec.role !== undefined ? { role: spec.role } : {}),
    ...(spec.modelKind !== undefined ? { modelKind: spec.modelKind } : {}),
    policy: {
      maxGeneration: 2,
      maxChildren: 2,
      allowDirectMessages: false,
      allowSkipContext: false,
      allowedModelKinds,
    },
  });
}

describe("heterogeneous graph: llm orchestrator + jev decision node", () => {
  function setup() {
    const decider = new StubDecider();
    const kinds = ["jev", "llm"] as const;

    const registry = new ModelKindRegistry({ defaultKind: "llm" })
      .register("llm", ({ spec }) => {
        // Root proposes one jev child, then answers.
        const model =
          spec.identity.generation === 0
            ? new ScriptedModel([
                createModelResponse({
                  content: null,
                  toolCalls: [
                    createToolCall({
                      id: "spawn-1",
                      name: SPAWN_TOOL,
                      arguments: {
                        role: "router",
                        objective: "Decide which team owns the ticket.",
                        instructions: "Classify the ticket.",
                        budget_share: 0.5,
                        model_kind: "jev",
                      },
                    }),
                  ],
                }),
                createModelResponse({ content: "Routed to the technical team." }),
              ])
            : new ScriptedModel([createModelResponse({ content: "unused" })]);
        return new AgentNode({ spec: toNodeSpec(spec, kinds), model, clock: () => 0 });
      })
      .register("jev", ({ spec }) => {
        return new JevNode({
          spec: toNodeSpec(spec, kinds),
          questions: ROUTE_QUESTIONS,
          client: decider,
          clock: () => 0,
        });
      });

    const controller = new GraphController(
      registry.asNodeFactory(),
      createControllerPolicy({
        maxNodes: 4,
        maxEdges: 8,
        maxGeneration: 2,
        maxChildrenPerNode: 2,
        maxTotalTokens: 32000,
        maxConcurrency: 2,
        allowedModelKinds: registry.kinds(),
      }),
      () => 0,
    );

    return { controller, registry, decider };
  }

  const rootSpec: OrchestratorAgentSpec = {
    identity: createAgentIdentity({
      nodeId: "root",
      name: "Orchestrator",
      role: "orchestrator",
      generation: 0,
    }),
    budget: createNodeBudget({
      maxTurns: 4,
      maxToolCalls: 4,
      maxTotalTokens: 8000,
      timeoutSeconds: 30,
    }),
    role: "orchestrator",
  };

  it("spawns a jev child, runs it, and converges", async () => {
    const { controller, registry, decider } = setup();
    expect(registry.kinds()).toEqual(["jev", "llm"]);

    const rootRunner = registry.create({ spec: rootSpec, toolNames: [] });
    await controller.createRun("run-1", rootSpec, rootRunner, createAgentInput({ task: "payouts failing 3 days" }));
    const snapshot = await controller.runUntilIdle("run-1");

    expect(snapshot.status).toBe(RunStatus.SUCCEEDED);
    expect(verifyControllerEventChain(controller.events("run-1"))).toBe(true);
    // The jev node actually ran, rather than being silently skipped.
    expect(decider.calls).toBe(1);
    expect(snapshot.nodes.length).toBe(2);
  });

  it("binds the child to the jev kind and keeps it distinct from the llm root", async () => {
    const { controller, registry } = setup();
    const rootRunner = registry.create({ spec: rootSpec, toolNames: [] });
    await controller.createRun("run-2", rootSpec, rootRunner, createAgentInput({ task: "ticket" }));
    const snapshot = await controller.runUntilIdle("run-2");

    const child = snapshot.nodes.find((n) => n.nodeId !== "root")!;
    expect(child.modelKind).toBe("jev");
    const root = snapshot.nodes.find((n) => n.nodeId === "root")!;
    expect(root.modelKind ?? "llm").toBe("llm");
  });

  it("surfaces the jev decision as readable JSON output on its node", async () => {
    // RunSnapshot.nodes carries graph structure, not node outputs, so capture
    // the jev node's result as the controller drives it.
    const outputs = new Map<string, string | null>();
    const decider = new StubDecider();
    const kinds = ["jev", "llm"] as const;
    const registry = new ModelKindRegistry({ defaultKind: "llm" })
      .register("llm", ({ spec }) =>
        new AgentNode({
          spec: toNodeSpec(spec, kinds),
          model:
            spec.identity.generation === 0
              ? new ScriptedModel([
                  createModelResponse({
                    content: null,
                    toolCalls: [
                      createToolCall({
                        id: "spawn-1",
                        name: SPAWN_TOOL,
                        arguments: {
                          role: "router",
                          objective: "Decide ownership.",
                          instructions: "Classify.",
                          budget_share: 0.5,
                          model_kind: "jev",
                        },
                      }),
                    ],
                  }),
                  createModelResponse({ content: "Routed." }),
                ])
              : new ScriptedModel([createModelResponse({ content: "unused" })]),
          clock: () => 0,
        }),
      )
      .register("jev", ({ spec }) => {
        const inner = new JevNode({
          spec: toNodeSpec(spec, kinds),
          questions: ROUTE_QUESTIONS,
          client: decider,
          clock: () => 0,
        });
        return {
          spec: inner.spec,
          async run(input, signal) {
            const result = await inner.run(input, signal);
            outputs.set(result.nodeId, result.output);
            return result;
          },
        };
      });

    const controller = new GraphController(
      registry.asNodeFactory(),
      createControllerPolicy({
        maxNodes: 4,
        maxConcurrency: 2,
        maxTotalTokens: 32000,
        allowedModelKinds: registry.kinds(),
      }),
      () => 0,
    );

    const rootRunner = registry.create({ spec: rootSpec, toolNames: [] });
    await controller.createRun("run-3", rootSpec, rootRunner, createAgentInput({ task: "ticket" }));
    await controller.runUntilIdle("run-3");

    expect(outputs.size).toBe(1);
    const parsed = JSON.parse([...outputs.values()][0]!);
    expect(parsed.answers.route.choice).toBe("technical");
    expect(parsed.answers.route.probabilities.technical).toBe(0.94);
    expect(parsed.answers.route.confidence).toBe(0.88);
    expect(parsed.answers.urgent.noul).toBe(0.96);
  });

  it("rejects a jev spawn when the host has not allowed that kind", async () => {
    const decider = new StubDecider();
    // Registry still knows jev, but the controller policy does not allow it.
    const registry = new ModelKindRegistry({ defaultKind: "llm" })
      .register("llm", ({ spec }) =>
        new AgentNode({
          spec: toNodeSpec(spec, ["jev", "llm"]),
          model:
            spec.identity.generation === 0
              ? new ScriptedModel([
                  createModelResponse({
                    content: null,
                    toolCalls: [
                      createToolCall({
                        id: "spawn-1",
                        name: SPAWN_TOOL,
                        arguments: {
                          role: "router",
                          objective: "Decide ownership.",
                          instructions: "Classify.",
                          budget_share: 0.5,
                          model_kind: "jev",
                        },
                      }),
                    ],
                  }),
                  createModelResponse({ content: "Answered without the router." }),
                ])
              : new ScriptedModel([createModelResponse({ content: "unused" })]),
          clock: () => 0,
        }),
      )
      .register("jev", ({ spec }) =>
        new JevNode({
          spec: toNodeSpec(spec, ["jev", "llm"]),
          questions: ROUTE_QUESTIONS,
          client: decider,
          clock: () => 0,
        }),
      );

    const controller = new GraphController(
      registry.asNodeFactory(),
      // allowedModelKinds omitted => fail closed, no proposal may carry one.
      createControllerPolicy({ maxNodes: 4, maxConcurrency: 2, maxTotalTokens: 32000 }),
      () => 0,
    );

    const rootRunner = registry.create({ spec: rootSpec, toolNames: [] });
    await controller.createRun("run-4", rootSpec, rootRunner, createAgentInput({ task: "ticket" }));
    const snapshot = await controller.runUntilIdle("run-4");

    // The graph still converges, but the jev node was never created or run.
    expect(snapshot.nodes.length).toBe(1);
    expect(decider.calls).toBe(0);
    expect(verifyControllerEventChain(controller.events("run-4"))).toBe(true);
  });
});
