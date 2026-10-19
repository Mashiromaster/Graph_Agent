/**
 * 异质图的 checkpoint / resume 闭环。
 *
 * 这是 modelKind 必须进入持久化层的理由:在它之前,没有任何记录、快照或
 * checkpoint 保存过某个节点跑的是哪个模型,于是 resume 只能依赖调用方
 * **恰好再传一个一样的工厂**。对同质图(全图一个模型)这无所谓;对异质图
 * 则意味着「谁是 jev、谁是 lightgbm」在重启后丢失。
 *
 * 下面的测试在 resume 时故意换一个**全新的**注册表实例,只靠 checkpoint 里
 * 的 modelKind 把每个节点重新分派回正确的 builder。
 */

import { describe, expect, it } from "vitest";
import {
  createAgentIdentity,
  createNodeBudget,
  createSpawnProposal,
  type AgentResult,
} from "@graph-agent/core";
import { createControllerPolicy } from "../src/policy.js";
import { NodeState, RunStatus } from "../src/graph-models.js";
import type { AgentSpec, NodeRunner } from "../src/runner.js";
import { ModelKindRegistry } from "../src/model-registry.js";
import { GraphController } from "../src/controller.js";
import { resumeController } from "../src/resume.js";
import { parseResumableCheckpoint } from "../src/checkpoint.js";
import { completedResult, agentInput } from "./fixtures.js";

const KINDS = ["jev", "lightgbm", "llm"] as const;

function policy() {
  return createControllerPolicy({
    maxTotalTokens: 10000,
    maxChildrenPerNode: 4,
    allowedModelKinds: [...KINDS],
  });
}

function rootSpec(): AgentSpec & { toolNames: readonly string[] } {
  return {
    identity: createAgentIdentity({
      nodeId: "root",
      name: "Orchestrator",
      role: "orchestrator",
      generation: 0,
    }),
    budget: createNodeBudget({ maxTotalTokens: 2000 }),
    role: "orchestrator",
    toolNames: [],
  };
}

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
 * 建一个注册表,并记录「哪个 nodeId 由哪个 kind 的 builder 创建」。
 * 这正是 resume 后要复现的映射。
 */
function registryWithLog(): {
  registry: ModelKindRegistry;
  built: Map<string, string>;
  ran: Map<string, string>;
} {
  const built = new Map<string, string>();
  const ran = new Map<string, string>();
  const registry = new ModelKindRegistry({ defaultKind: "llm" });
  for (const kind of KINDS) {
    registry.register(kind, ({ spec }): NodeRunner => {
      const nodeId = spec.identity.nodeId;
      built.set(nodeId, kind);
      return {
        spec,
        run: async (): Promise<AgentResult> => {
          ran.set(nodeId, kind);
          return completedResult(nodeId, 2, 2);
        },
      };
    });
  }
  return { registry, built, ran };
}

/** 主 Agent:派生三个不同模型类型的子节点,并按权重分配预算。 */
function weightingRoot(): NodeRunner {
  const shares: Record<(typeof KINDS)[number], number> = {
    jev: 0.5,
    lightgbm: 0.3,
    llm: 0.2,
  };
  return {
    spec: { identity: {} as never, budget: {} as never },
    run: async (): Promise<AgentResult> =>
      completedResult(
        "root",
        5,
        5,
        KINDS.map((kind, index) =>
          createSpawnProposal({
            proposalId: `sp-${kind}`,
            parentNodeId: "root",
            generation: 1,
            role: `${kind}-worker`,
            objective: `run ${kind}`,
            instructions: `you are the ${kind} worker`,
            toolNames: [],
            // 主 Agent 计算出的调度/预算权重。
            priority: 1 - index * 0.25,
            budgetShare: shares[kind],
            modelKind: kind,
          }),
        ),
      ),
  };
}

describe("异质图:主 Agent 派生多种模型类型并分配权重", () => {
  it("每个子节点绑定到自己的 modelKind,预算按 budgetShare 分配", async () => {
    const { registry, built } = registryWithLog();
    const controller = new GraphController(registry, policy());
    await controller.createRun("run-h", rootSpec(), weightingRoot(), agentInput("root"));
    const snapshot = await controller.runSuperstep("run-h");

    const children = snapshot.nodes.filter((n) => n.parentNodeId === "root");
    expect(children).toHaveLength(3);

    const byKind = new Map(children.map((n) => [n.modelKind, n]));
    expect([...byKind.keys()].sort()).toEqual(["jev", "lightgbm", "llm"]);

    // 工厂确实按 modelKind 分派(而非全图一个模型)。
    for (const child of children) {
      expect(built.get(child.nodeId)).toBe(child.modelKind);
    }

    // 预算权重:root 分到 2000,份额 0.5/0.3/0.2 → 1000/600/400。
    expect(byKind.get("jev")!.allocationTokens).toBe(1000);
    expect(byKind.get("lightgbm")!.allocationTokens).toBe(600);
    expect(byKind.get("llm")!.allocationTokens).toBe(400);

    // priority 只影响前沿内调度顺序,不与预算混用。
    expect(byKind.get("jev")!.priority).toBe(1);
    expect(byKind.get("llm")!.priority).toBe(0.5);
  });

  it("checkpoint 携带每个节点的 modelKind", async () => {
    const { registry } = registryWithLog();
    const controller = new GraphController(registry, policy());
    await controller.createRun("run-h", rootSpec(), weightingRoot(), agentInput("root"));
    await controller.runSuperstep("run-h");

    const json = await controller.checkpointResumable("run-h");
    const { resumable } = parseResumableCheckpoint(json);

    const kinds = resumable.nodes
      .filter((n) => n.nodeId !== "root")
      .map((n) => n.modelKind)
      .sort();
    expect(kinds).toEqual(["jev", "lightgbm", "llm"]);
  });

  it("resume 用全新注册表仍把每个节点分派回正确的 builder", async () => {
    // 第一段:跑一个超步,root 完成并派生三个异质子节点(均 READY,未跑)。
    const first = registryWithLog();
    const c1 = new GraphController(first.registry, policy());
    await c1.createRun("run-h", rootSpec(), weightingRoot(), agentInput("root"));
    const afterOne = await c1.runSuperstep("run-h");
    expect(afterOne.status).toBe(RunStatus.RUNNING);

    const expected = new Map(
      afterOne.nodes
        .filter((n) => n.parentNodeId === "root")
        .map((n) => [n.nodeId, n.modelKind!]),
    );
    expect(expected.size).toBe(3);

    const json = await c1.checkpointResumable("run-h");

    // 第二段:换一个**全新**注册表 resume——没有任何来自第一段的内存状态,
    // 唯一的信息来源是 checkpoint 里的 modelKind。
    const second = registryWithLog();
    const c2 = resumeController(json, second.registry, {
      policy: policy(),
      clock: () => 0,
      rehydrateSpec,
    });
    const final = await c2.runUntilIdle("run-h");

    // 已完成的 root 不重建、不重跑。
    expect(second.built.has("root")).toBe(false);
    expect(second.ran.has("root")).toBe(false);

    // 三个子节点各自回到正确的 builder,且真的跑了。
    for (const [nodeId, kind] of expected) {
      expect(second.built.get(nodeId)).toBe(kind);
      expect(second.ran.get(nodeId)).toBe(kind);
    }

    expect(final.status).toBe(RunStatus.SUCCEEDED);
    expect(final.nodes.every((n) => n.state === NodeState.SUCCEEDED)).toBe(true);

    // resume 后快照仍保有绑定。
    const kindsAfter = final.nodes
      .filter((n) => n.parentNodeId === "root")
      .map((n) => n.modelKind)
      .sort();
    expect(kindsAfter).toEqual(["jev", "lightgbm", "llm"]);
  });

  it("白名单收紧后,已物化的节点仍能 resume(白名单只约束新提案)", async () => {
    // 这是刻意的语义:allowedModelKinds 是**准入**控制,不是运行期的持续
    // 校验。已经进图的节点不会因为宿主之后收紧白名单而无法恢复。
    const first = registryWithLog();
    const c1 = new GraphController(first.registry, policy());
    await c1.createRun("run-h", rootSpec(), weightingRoot(), agentInput("root"));
    await c1.runSuperstep("run-h");
    const json = await c1.checkpointResumable("run-h");

    const second = registryWithLog();
    const c2 = resumeController(json, second.registry, {
      // 收紧到只剩 jev;已存在的 lightgbm / llm 节点不受影响。
      policy: createControllerPolicy({
        maxTotalTokens: 10000,
        maxChildrenPerNode: 4,
        allowedModelKinds: ["jev"],
      }),
      clock: () => 0,
      rehydrateSpec,
    });
    const final = await c2.runUntilIdle("run-h");

    expect(final.status).toBe(RunStatus.SUCCEEDED);
    expect([...second.ran.values()].sort()).toEqual(["jev", "lightgbm", "llm"]);
  });

  it("同质图(无 modelKind)的 checkpoint 串不含该键", async () => {
    // 向后兼容的守卫:既有 checkpoint 的 stateDigest 必须仍可复算。
    const registry = new ModelKindRegistry({ defaultKind: "llm" }).register(
      "llm",
      ({ spec }): NodeRunner => ({
        spec,
        run: async () => completedResult(spec.identity.nodeId, 2, 2),
      }),
    );
    const controller = new GraphController(registry, createControllerPolicy());
    const root: NodeRunner = {
      spec: { identity: {} as never, budget: {} as never },
      run: async () => completedResult("root", 5, 5),
    };
    await controller.createRun("run-plain", rootSpec(), root, agentInput("root"));
    await controller.runUntilIdle("run-plain");

    const json = await controller.checkpointResumable("run-plain");
    expect(json).not.toContain("modelKind");
  });
});
