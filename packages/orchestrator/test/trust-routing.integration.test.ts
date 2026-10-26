/**
 * Phase-3 关卡:权重不再惰性。
 *
 * 在本阶段之前,四类标量里只有 `priority` 和 `budgetShare` 真正影响行为,而
 * `trust` 仅被渲染进 prompt 文本——没有任何代码据它做决策,也没有任何机制从
 * 结果反推并更新它。本关卡验证两件事:
 *
 *   1. **按角色键的可信度表在 spawn 时注入子节点 identity**,从而跨运行生效;
 *   2. **低可信度源的投递被 minTrustScore 丢弃**,即 trust 真的参与了路由决策。
 *
 * 第 2 点同时是鲁棒性实验(调研 §14 的「注入错误 agent」臂)的机制基础:
 * 一个被注入的恶意/失准角色,其产出能否污染下游,取决于这道门是否生效。
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
import { RunStatus } from "../src/graph-models.js";
import { GraphController } from "../src/controller.js";
import { createTrustTable } from "../src/trust.js";
import type { AgentSpec, NodeFactory, NodeRunner } from "../src/runner.js";
import { agentInput } from "./fixtures.js";

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

function spawnOf(proposalId: string, role: string, objective: string): SpawnProposal {
  return createSpawnProposal({
    proposalId,
    parentNodeId: "root",
    generation: 1,
    role,
    objective,
    instructions: `instructions for ${role}`,
    toolNames: [],
    priority: 0.5,
    budgetShare: 0.2,
  });
}

/** 跑一次「root 派生 suspect + reducer,reducer 依赖 suspect」的图。 */
async function runWithTrust(opts: {
  trust: Record<string, number>;
  minTrustScore?: number;
}): Promise<{
  seen: Map<string, AgentInput>;
  specTrust: Map<string, number>;
  reducerId: string;
  suspectId: string;
  status: string;
}> {
  const seen = new Map<string, AgentInput>();
  const specTrust = new Map<string, number>();

  const factory: NodeFactory = {
    create: ({ spec }) => {
      const nodeId = spec.identity.nodeId;
      specTrust.set(nodeId, spec.identity.trustScore);
      const role = spec.role ?? "worker";
      return {
        spec,
        run: async (input: AgentInput): Promise<AgentResult> => {
          seen.set(nodeId, input);
          return resultWithOutput(nodeId, `payload from the ${role}`);
        },
      } satisfies NodeRunner;
    },
  };

  const rootSpec = rootSpecOf();
  const rootRunner: NodeRunner = {
    spec: rootSpec,
    run: async (input: AgentInput): Promise<AgentResult> => {
      seen.set("root", input);
      return resultWithOutput("root", "delegated", [
        spawnOf("sp-suspect", "suspect", "produce the payload"),
        spawnOf("sp-red", "reducer", "consume the payload"),
      ]);
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
      ...(opts.minTrustScore !== undefined
        ? { minTrustScore: opts.minTrustScore }
        : {}),
    }),
    () => 0,
    createTrustTable(opts.trust),
  );
  await controller.createRun("r", rootSpec, rootRunner, agentInput("root"));

  const afterRoot = await controller.runSuperstep("r");
  const children = afterRoot.nodes.filter((n) => n.parentNodeId === "root");
  const suspect = children.find((n) => n.role === "suspect")!;
  const reducer = children.find((n) => n.role === "reducer")!;
  await controller.addDependency("r", suspect.nodeId, reducer.nodeId);

  const final = await controller.runUntilIdle("r");
  return {
    seen,
    specTrust,
    reducerId: reducer.nodeId,
    suspectId: suspect.nodeId,
    status: final.status,
  };
}

describe("role trust reaches spawned children", () => {
  it("injects the role-keyed table value into the child identity", async () => {
    const { specTrust, suspectId, reducerId } = await runWithTrust({
      trust: { suspect: 0.2, reducer: 0.9 },
    });
    expect(specTrust.get(suspectId)).toBeCloseTo(0.2, 10);
    expect(specTrust.get(reducerId)).toBeCloseTo(0.9, 10);
  });

  it("defaults an unlisted role to full trust", async () => {
    const { specTrust, suspectId } = await runWithTrust({ trust: {} });
    expect(specTrust.get(suspectId)).toBe(1);
  });

  it("labels the spawn context with the PARENT's trust, not the child's", async () => {
    // 内容来自父节点的 instructions,故可信度必须是父节点的。此前误用子节点
    // identity 的 trustScore——trust 全为 1 时无差别,但角色级可信度生效后,
    // 会把子节点的先验错当成这段内容的可信度。
    const { seen, suspectId } = await runWithTrust({
      // root 不在表里 → 父节点 trust = 1;suspect 角色先验很低。
      trust: { suspect: 0.2 },
    });
    const spawnPacket = seen
      .get(suspectId)!
      .context.find((p) => p.edgeType === "spawn")!;
    expect(spawnPacket.sourceNodeId).toBe("root");
    expect(spawnPacket.trust).toBe(1);
    // 内容是父节点给的指令,而非父节点的完整产出(见 applySpawn 注释)。
    expect(spawnPacket.content).toBe("instructions for suspect");
    expect(spawnPacket.content).not.toContain("delegated");
  });
});

describe("trust gates delivery", () => {
  it("delivers a dependency payload when the source clears minTrustScore", async () => {
    const { seen, reducerId, status } = await runWithTrust({
      trust: { suspect: 0.9 },
      minTrustScore: 0.5,
    });
    expect(status).toBe(RunStatus.SUCCEEDED);
    const delivered = seen
      .get(reducerId)!
      .context.filter((p) => p.edgeType === "depends_on");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.trust).toBeCloseTo(0.9, 10);
    expect(delivered[0]!.content).toContain("payload from the suspect");
  });

  it("drops the payload of a source below minTrustScore", async () => {
    // 核心鲁棒性性质:注入的低可信角色,其产出不得进入下游上下文——
    // 即便那是一条声明式 depends_on 数据流边。
    const { seen, reducerId, status } = await runWithTrust({
      trust: { suspect: 0.1 },
      minTrustScore: 0.5,
    });
    expect(status).toBe(RunStatus.SUCCEEDED);
    expect(
      seen.get(reducerId)!.context.filter((p) => p.edgeType === "depends_on"),
    ).toHaveLength(0);
  });

  it("delivers regardless of trust when the gate is open (minTrustScore=0)", async () => {
    const { seen, reducerId } = await runWithTrust({
      trust: { suspect: 0.1 },
      minTrustScore: 0,
    });
    expect(
      seen.get(reducerId)!.context.filter((p) => p.edgeType === "depends_on"),
    ).toHaveLength(1);
  });
});
