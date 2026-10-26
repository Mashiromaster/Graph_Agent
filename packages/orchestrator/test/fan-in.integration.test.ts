/**
 * Phase-2 关卡:`depends_on` 成为数据流边,真实 fan-in 可用。
 *
 * 在本阶段之前,编排层**完全没有子→父或兄弟→兄弟的信息流**:
 *   - 子节点的 AgentResult 只进 archivedResults 供 checkpoint,没有任何代码读它;
 *   - 父节点在子节点进入下一个 superstep 之前就已跑完,且节点永不重入;
 *   - message / skip_context 边只记 sha256(content) 并丢弃明文,全仓库只写不读。
 * 因此「多 agent 通讯有效性」在可观测意义上无从评估——这正是本关卡要解除的前提。
 *
 * reducer 模式:root 派生 w1、w2 与 reducer,再对 reducer 加两条 depends_on 边。
 * w1/w2 在第二个 superstep 跑完并归档,reducer 被依赖边挡到第三个 superstep,
 * 届时经 injectDeliveries 拿到**两份实际产出**。
 */

import { describe, expect, it } from "vitest";
import {
  NodeStatus,
  EventRecorder,
  EventType,
  createAgentIdentity,
  createAgentResult,
  createNodeBudget,
  createSpawnProposal,
  createUsage,
  resultBindingHash,
  type AgentInput,
  type AgentResult,
  type SpawnProposal,
} from "@graph-agent/core";
import { createControllerPolicy } from "../src/policy.js";
import { NodeState, RunStatus } from "../src/graph-models.js";
import { GraphController } from "../src/controller.js";
import type { AgentSpec, NodeFactory, NodeRunner } from "../src/runner.js";
import { agentInput } from "./fixtures.js";

/** 带真实事件链与绑定哈希的 COMPLETED 结果,输出文本可控。 */
function resultWithOutput(
  nodeId: string,
  output: string,
  spawnProposals: readonly SpawnProposal[] = [],
): AgentResult {
  const inputTokens = 3;
  const outputTokens = 3;
  const resultHash = resultBindingHash({
    nodeId,
    status: NodeStatus.COMPLETED,
    output,
    inputTokens,
    outputTokens,
    spawnProposals: spawnProposals as never,
    messageProposals: [] as never,
    skipContextProposals: [] as never,
  });
  const recorder = new EventRecorder(nodeId, () => 0);
  recorder.record({ type: EventType.NODE_STARTED });
  recorder.record({
    type: EventType.NODE_COMPLETED,
    metadata: { result_hash: resultHash },
  });
  return createAgentResult({
    nodeId,
    status: NodeStatus.COMPLETED,
    output,
    usage: createUsage({ inputTokens, outputTokens }),
    events: recorder.events,
    spawnProposals: spawnProposals as never,
    messageProposals: [] as never,
    skipContextProposals: [] as never,
  });
}

function rootSpecOf(): AgentSpec & { toolNames: readonly string[] } {
  return {
    identity: createAgentIdentity({
      nodeId: "root",
      name: "Root",
      role: "orchestrator",
      generation: 0,
    }),
    budget: createNodeBudget({ maxTotalTokens: 1000 }),
    role: "orchestrator",
    toolNames: [],
  };
}

/** 三个 spawn 提案:两个 worker + 一个 reducer。 */
function threeChildren(): SpawnProposal[] {
  const mk = (id: string, role: string, objective: string) =>
    createSpawnProposal({
      proposalId: id,
      parentNodeId: "root",
      generation: 1,
      role,
      objective,
      instructions: `instructions for ${role}`,
      toolNames: [],
      priority: 0.5,
      budgetShare: 0.2,
    });
  return [
    mk("sp-w1", "worker", "study the first half"),
    mk("sp-w2", "worker", "study the second half"),
    mk("sp-red", "reducer", "combine the worker findings"),
  ];
}

/**
 * 驱动一次 reducer 模式运行,返回每个节点实际收到的 input。
 *
 * @param addDeps 是否给 reducer 加 depends_on 边(false = 投递关闭的对照组)
 */
async function runReducerGraph(addDeps: boolean): Promise<{
  seen: Map<string, AgentInput>;
  status: string;
  ids: { w1: string; w2: string; reducer: string };
}> {
  const seen = new Map<string, AgentInput>();
  const factory: NodeFactory = {
    create: ({ spec }) => {
      const nodeId = spec.identity.nodeId;
      const role = spec.role ?? "worker";
      return {
        spec,
        run: async (input: AgentInput): Promise<AgentResult> => {
          seen.set(nodeId, input);
          return resultWithOutput(
            nodeId,
            role === "reducer"
              ? "combined report"
              : `finding from ${nodeId}: superconductivity at 12 kelvin`,
          );
        },
      } satisfies NodeRunner;
    },
  };

  const rootSpec = rootSpecOf();
  const rootRunner: NodeRunner = {
    spec: rootSpec,
    run: async (input: AgentInput): Promise<AgentResult> => {
      seen.set("root", input);
      return resultWithOutput("root", "delegated", threeChildren());
    },
  };

  const controller = new GraphController(
    factory,
    createControllerPolicy({
      maxNodes: 8,
      maxEdges: 24,
      maxGeneration: 2,
      maxChildrenPerNode: 4,
      maxTotalTokens: 8000,
      maxConcurrency: 4,
    }),
  );
  await controller.createRun("r", rootSpec, rootRunner, agentInput("root"));

  // superstep 1: root 跑完,三个子节点物化为 READY。
  const afterRoot = await controller.runSuperstep("r");
  const children = afterRoot.nodes.filter((n) => n.parentNodeId === "root");
  expect(children).toHaveLength(3);
  const reducerNode = children.find((n) => n.role === "reducer")!;
  const workers = children.filter((n) => n.role === "worker");
  expect(workers).toHaveLength(2);

  if (addDeps) {
    // reducer 依赖两个 worker:把它挡到下一个 superstep,并在届时取两份产出。
    for (const w of workers) {
      await controller.addDependency("r", w.nodeId, reducerNode.nodeId);
    }
  }

  const final = await controller.runUntilIdle("r");
  return {
    seen,
    status: final.status,
    ids: {
      w1: workers[0]!.nodeId,
      w2: workers[1]!.nodeId,
      reducer: reducerNode.nodeId,
    },
  };
}

describe("fan-in via depends_on", () => {
  it("delivers both dependencies' actual outputs to the reducer", async () => {
    const { seen, status, ids } = await runReducerGraph(true);
    expect(status).toBe(RunStatus.SUCCEEDED);

    const reducerInput = seen.get(ids.reducer)!;
    // 基底 context 是 spawn 时父节点注入的一条 instructions packet。
    const delivered = reducerInput.context.filter((p) => p.edgeType === "depends_on");
    expect(delivered).toHaveLength(2);

    const sources = delivered.map((p) => p.sourceNodeId).sort();
    expect(sources).toEqual([ids.w1, ids.w2].sort());
    // 关键:投递的是 worker 的**实际产出**,不是提案文本。
    for (const packet of delivered) {
      expect(packet.content).toContain("superconductivity at 12 kelvin");
      expect(packet.content).toContain(packet.sourceNodeId);
    }
  });

  it("delivers nothing when no dependency edge exists (control arm)", async () => {
    const { seen, status, ids } = await runReducerGraph(false);
    expect(status).toBe(RunStatus.SUCCEEDED);
    const reducerInput = seen.get(ids.reducer)!;
    expect(reducerInput.context.filter((p) => p.edgeType === "depends_on")).toHaveLength(
      0,
    );
  });

  it("workers themselves receive no dependency context", async () => {
    const { seen, ids } = await runReducerGraph(true);
    for (const id of [ids.w1, ids.w2]) {
      expect(seen.get(id)!.context.filter((p) => p.edgeType === "depends_on")).toHaveLength(
        0,
      );
    }
  });
});
