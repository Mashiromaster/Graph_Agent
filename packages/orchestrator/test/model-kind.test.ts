/**
 * modelKind 的信任边界与持久化。
 *
 * 覆盖四件事:
 * 1. policy 白名单的 fail-closed 方向(默认空 ⇒ 一律拒绝);
 * 2. validateSpawn 的 MODEL_KIND_NOT_PERMITTED,及其相对 PERMISSION_ESCALATION
 *    的检查顺序(权限面先于预算面);
 * 3. applySpawn 把 modelKind 写进 NodeRecord 与 spec,且状态流转不丢失它;
 * 4. 省略 modelKind 时快照 dict **逐字节不变**——这是既有 checkpoint 的
 *    stateDigest 仍能复算的前提。
 */

import { describe, expect, it } from "vitest";
import { canonicalJson, createSpawnProposal } from "@graph-agent/core";
import { createControllerPolicy } from "../src/policy.js";
import { createMutableRunState, snapshotOf } from "../src/mutable-state.js";
import {
  NodeState,
  createNodeRecord,
  runSnapshotFromDict,
  runSnapshotToDict,
  type NodeRecord,
} from "../src/graph-models.js";
import { applySpawn } from "../src/mutations.js";
import { validateSpawn } from "../src/validation.js";
import { ModelKindRegistry } from "../src/model-registry.js";
import type { AgentSpec, NodeFactory, NodeRunner } from "../src/runner.js";
import {
  createAgentResult,
  createUsage,
  NodeStatus,
  type AgentInput,
  type AgentResult,
} from "@graph-agent/core";

const RUN_ID = "run-mk";

function stubRunner(spec: AgentSpec): NodeRunner {
  return {
    spec,
    async run(_input: AgentInput): Promise<AgentResult> {
      return createAgentResult({
        nodeId: spec.identity.nodeId,
        status: NodeStatus.COMPLETED,
        output: "ok",
        usage: createUsage(),
        events: [],
      });
    },
  };
}

/** 工厂:记录每次 create 收到的 spec,供断言 modelKind 是否送达。 */
function recordingFactory(): NodeFactory & { seen: (string | undefined)[] } {
  return {
    seen: [],
    create(args: { spec: AgentSpec; toolNames: readonly string[] }): NodeRunner {
      this.seen.push(args.spec.modelKind);
      return stubRunner(args.spec);
    },
  };
}

/**
 * 带一个 RUNNING 根节点的状态。根只预留 1000/10000,给子节点留足全局额度——
 * 否则 0.5 份额的子节点会先撞上 TOKEN_BUDGET_EXHAUSTED,测不到 modelKind。
 */
function stateWithRoot(allowedModelKinds: readonly string[] = []) {
  const policy = createControllerPolicy({
    maxTotalTokens: 10000,
    allowedModelKinds,
  });
  const state = createMutableRunState(RUN_ID, policy);
  const root = createNodeRecord({
    nodeId: "root",
    name: "Root Agent",
    role: "root",
    parentNodeId: null,
    generation: 0,
    priority: 0.5,
    state: NodeState.RUNNING,
    allowedToolNames: ["a", "b"],
    allocationTokens: 1000,
  });
  state.nodes.set(root.nodeId, root);
  state.nodeReservations.set(root.nodeId, 1000);
  state.reservedTokens += 1000;
  return { state, root };
}

function spawn(overrides: Record<string, unknown> = {}) {
  return createSpawnProposal({
    proposalId: "p1",
    parentNodeId: "root",
    generation: 1,
    role: "worker",
    objective: "do the thing",
    instructions: "instructions here",
    toolNames: ["a"],
    priority: 0.5,
    budgetShare: 0.5,
    ...overrides,
  });
}

describe("policy.allowedModelKinds", () => {
  it("默认为空数组:模型类型须由宿主显式开启", () => {
    expect(createControllerPolicy().allowedModelKinds).toEqual([]);
  });

  it("去重并排序,使白名单与声明顺序无关", () => {
    const policy = createControllerPolicy({
      allowedModelKinds: ["llm", "jev", "llm", "lightgbm"],
    });
    expect(policy.allowedModelKinds).toEqual(["jev", "lightgbm", "llm"]);
  });

  it("拒绝空白的类型名", () => {
    expect(() => createControllerPolicy({ allowedModelKinds: ["jev", "  "] })).toThrow();
  });

  it("冻结白名单数组", () => {
    const policy = createControllerPolicy({ allowedModelKinds: ["jev"] });
    expect(Object.isFrozen(policy.allowedModelKinds)).toBe(true);
  });
});

describe("validateSpawn — modelKind", () => {
  it("白名单为空时拒绝任何 modelKind", () => {
    const { state, root } = stateWithRoot([]);
    const failure = validateSpawn(
      spawn({ modelKind: "jev" }),
      root,
      { nodes: state.nodes, edges: state.edges },
      state.policy,
    );
    expect(failure?.code).toBe("MODEL_KIND_NOT_PERMITTED");
  });

  it("接受白名单内的 modelKind", () => {
    const { state, root } = stateWithRoot(["jev", "llm"]);
    const failure = validateSpawn(
      spawn({ modelKind: "jev" }),
      root,
      { nodes: state.nodes, edges: state.edges },
      state.policy,
    );
    expect(failure).toBeNull();
  });

  it("拒绝白名单外的 modelKind", () => {
    const { state, root } = stateWithRoot(["jev"]);
    const failure = validateSpawn(
      spawn({ modelKind: "lightgbm" }),
      root,
      { nodes: state.nodes, edges: state.edges },
      state.policy,
    );
    expect(failure?.code).toBe("MODEL_KIND_NOT_PERMITTED");
    expect(failure?.message).toContain("lightgbm");
  });

  it("省略 modelKind 时照旧通过(向后兼容)", () => {
    const { state, root } = stateWithRoot([]);
    const failure = validateSpawn(
      spawn(),
      root,
      { nodes: state.nodes, edges: state.edges },
      state.policy,
    );
    expect(failure).toBeNull();
  });

  it("工具越权先于 modelKind 被报出(权限面按既定顺序)", () => {
    const { state, root } = stateWithRoot([]);
    const failure = validateSpawn(
      spawn({ toolNames: ["forbidden"], modelKind: "jev" }),
      root,
      { nodes: state.nodes, edges: state.edges },
      state.policy,
    );
    expect(failure?.code).toBe("PERMISSION_ESCALATION");
  });

  it("modelKind 先于预算份额被报出(权限面先于预算面)", () => {
    const { state, root } = stateWithRoot([]);
    const failure = validateSpawn(
      spawn({ modelKind: "jev", budgetShare: 1 }),
      root,
      { nodes: state.nodes, edges: state.edges },
      state.policy,
    );
    expect(failure?.code).toBe("MODEL_KIND_NOT_PERMITTED");
  });

  it("超长 modelKind 记为 MALFORMED_PROPOSAL", () => {
    const { state, root } = stateWithRoot(["jev"]);
    const failure = validateSpawn(
      { ...spawn(), modelKind: "x".repeat(300) },
      root,
      { nodes: state.nodes, edges: state.edges },
      state.policy,
    );
    expect(failure?.code).toBe("MALFORMED_PROPOSAL");
  });
});

describe("applySpawn — modelKind 物化", () => {
  it("写入 NodeRecord 并随 spec 送达工厂", () => {
    const { state, root } = stateWithRoot(["jev"]);
    const factory = recordingFactory();
    const decision = applySpawn(state, root, spawn({ modelKind: "jev" }), 0, factory, RUN_ID);

    expect(decision.state).toBe("accepted");
    const child = state.nodes.get(decision.materializedId!)!;
    expect(child.modelKind).toBe("jev");
    expect(factory.seen).toEqual(["jev"]);
    expect((state.specs.get(child.nodeId) as AgentSpec).modelKind).toBe("jev");
  });

  it("未指定时 NodeRecord.modelKind 为 null,spec 不含该键", () => {
    const { state, root } = stateWithRoot([]);
    const factory = recordingFactory();
    const decision = applySpawn(state, root, spawn(), 0, factory, RUN_ID);

    const child = state.nodes.get(decision.materializedId!)!;
    expect(child.modelKind).toBeNull();
    expect(factory.seen).toEqual([undefined]);
    expect("modelKind" in (state.specs.get(child.nodeId) as object)).toBe(false);
  });

  it("白名单外的 modelKind 整体拒绝,不物化任何东西", () => {
    const { state, root } = stateWithRoot(["jev"]);
    const factory = recordingFactory();
    const before = state.nodes.size;
    const decision = applySpawn(
      state,
      root,
      spawn({ modelKind: "lightgbm" }),
      0,
      factory,
      RUN_ID,
    );

    expect(decision.state).toBe("rejected");
    expect(decision.code).toBe("MODEL_KIND_NOT_PERMITTED");
    expect(state.nodes.size).toBe(before);
    expect(factory.seen).toEqual([]);
  });

  it("异质子节点各自保留自己的 modelKind", () => {
    const { state, root } = stateWithRoot(["jev", "lightgbm"]);
    const factory = recordingFactory();
    applySpawn(state, root, spawn({ proposalId: "p1", modelKind: "jev", budgetShare: 0.5 }), 0, factory, RUN_ID);
    applySpawn(
      state,
      root,
      spawn({ proposalId: "p2", modelKind: "lightgbm", budgetShare: 0.3 }),
      1,
      factory,
      RUN_ID,
    );

    const kinds = [...state.nodes.values()]
      .filter((n) => n.parentNodeId === "root")
      .map((n) => n.modelKind)
      .sort();
    expect(kinds).toEqual(["jev", "lightgbm"]);
    expect(factory.seen.sort()).toEqual(["jev", "lightgbm"]);
  });
});

describe("快照序列化 — 向后兼容", () => {
  it("modelKind 为 null 时整键省略,dict 与旧行为逐字节一致", () => {
    const { state } = stateWithRoot([]);
    const dict = runSnapshotToDict(snapshotOf(state));
    const node = (dict.nodes as Record<string, unknown>[])[0]!;
    expect("modelKind" in node).toBe(false);
  });

  it("modelKind 非空时出现在 dict 里", () => {
    const { state, root } = stateWithRoot(["jev"]);
    applySpawn(state, root, spawn({ modelKind: "jev" }), 0, recordingFactory(), RUN_ID);
    const dict = runSnapshotToDict(snapshotOf(state));
    const child = (dict.nodes as Record<string, unknown>[]).find(
      (n) => n.parentNodeId === "root",
    )!;
    expect(child.modelKind).toBe("jev");
  });

  it("往返保真:异质图经 dict 还原后 modelKind 不变", () => {
    const { state, root } = stateWithRoot(["jev"]);
    applySpawn(state, root, spawn({ modelKind: "jev" }), 0, recordingFactory(), RUN_ID);
    const restored = runSnapshotFromDict(runSnapshotToDict(snapshotOf(state)));
    const child = restored.nodes.find((n) => n.parentNodeId === "root")!;
    expect(child.modelKind).toBe("jev");
  });

  it("缺 modelKind 键的旧 dict 可解析为 null", () => {
    const { state } = stateWithRoot([]);
    const dict = runSnapshotToDict(snapshotOf(state));
    const restored = runSnapshotFromDict(dict);
    expect(restored.nodes[0]!.modelKind).toBeNull();
  });

  it("同质图的 canonicalJson 不因本特性改变", () => {
    // 若 modelKind 被无条件写入(哪怕是 null),此串就会变化,既有 checkpoint
    // 的 stateDigest 将无法复算。此测试即为那条回归的守卫。
    const { state } = stateWithRoot([]);
    const json = canonicalJson(runSnapshotToDict(snapshotOf(state)));
    expect(json).not.toContain("modelKind");
  });
});

describe("状态流转保留 modelKind", () => {
  it("READY → RUNNING → SUCCEEDED 全程不丢失绑定", () => {
    // withNodeState 经 createNodeRecord 重建记录;漏传 modelKind 会静默清空它。
    let node: NodeRecord = createNodeRecord({
      nodeId: "n1",
      name: "Worker Agent",
      role: "worker",
      parentNodeId: "root",
      generation: 1,
      priority: 0.5,
      state: NodeState.READY,
      allowedToolNames: ["a"],
      allocationTokens: 100,
      modelKind: "jev",
    });
    for (const next of [NodeState.RUNNING, NodeState.SUCCEEDED]) {
      node = createNodeRecord({ ...node, state: next });
      expect(node.modelKind).toBe("jev");
    }
  });
});

describe("ModelKindRegistry", () => {
  const build = (label: string) => (args: { spec: AgentSpec }) => {
    const runner = stubRunner(args.spec) as NodeRunner & { label?: string };
    runner.label = label;
    return runner;
  };

  function specWith(modelKind?: string): AgentSpec {
    return {
      identity: {
        nodeId: "n1",
        name: "Worker",
        role: "worker",
        generation: 1,
        parentNodeId: "root",
        trustScore: 1,
      },
      budget: { maxTurns: 4, maxToolCalls: 8, maxTotalTokens: 100, timeoutSeconds: 30 },
      ...(modelKind !== undefined ? { modelKind } : {}),
    } as AgentSpec;
  }

  it("按 modelKind 分派到对应 builder", () => {
    const registry = new ModelKindRegistry()
      .register("jev", build("jev"))
      .register("lightgbm", build("lightgbm"));

    const runner = registry.create({ spec: specWith("jev"), toolNames: [] });
    expect((runner as { label?: string }).label).toBe("jev");
  });

  it("kinds() 升序返回,可直接喂给 policy", () => {
    const registry = new ModelKindRegistry()
      .register("llm", build("llm"))
      .register("jev", build("jev"));
    expect(registry.kinds()).toEqual(["jev", "llm"]);

    const policy = createControllerPolicy({ allowedModelKinds: registry.kinds() });
    expect(policy.allowedModelKinds).toEqual(["jev", "llm"]);
  });

  it("未指定 modelKind 时用 defaultKind", () => {
    const registry = new ModelKindRegistry({ defaultKind: "llm" }).register(
      "llm",
      build("llm"),
    );
    const runner = registry.create({ spec: specWith(), toolNames: [] });
    expect((runner as { label?: string }).label).toBe("llm");
  });

  it("未指定 modelKind 且无 defaultKind 时抛错,绝不静默挑一个", () => {
    const registry = new ModelKindRegistry().register("llm", build("llm"));
    expect(() => registry.create({ spec: specWith(), toolNames: [] })).toThrow(
      /no modelKind/,
    );
  });

  it("未注册的 kind 抛错(控制器会记为 FACTORY_ERROR)", () => {
    const registry = new ModelKindRegistry().register("jev", build("jev"));
    expect(() => registry.create({ spec: specWith("lightgbm"), toolNames: [] })).toThrow(
      /no runner registered/,
    );
  });

  it("重复注册抛错,不让后者静默覆盖前者", () => {
    const registry = new ModelKindRegistry().register("jev", build("jev"));
    expect(() => registry.register("jev", build("other"))).toThrow(/already registered/);
  });

  it("拒绝空类型名", () => {
    expect(() => new ModelKindRegistry().register("  ", build("x"))).toThrow();
  });

  it("可直接当 NodeFactory 用,经 applySpawn 建出对应 runner", () => {
    const registry = new ModelKindRegistry()
      .register("jev", build("jev"))
      .register("lightgbm", build("lightgbm"));
    const { state, root } = stateWithRoot(registry.kinds());

    const decision = applySpawn(
      state,
      root,
      spawn({ modelKind: "lightgbm" }),
      0,
      registry,
      RUN_ID,
    );
    expect(decision.state).toBe("accepted");
    const runner = state.runners.get(decision.materializedId!) as { label?: string };
    expect(runner.label).toBe("lightgbm");
  });

  it("未注册的 kind 经 applySpawn 落为 FACTORY_ERROR", () => {
    // 白名单放行但注册表没有 → 工厂抛错 → 控制器整体拒绝该提案。
    const registry = new ModelKindRegistry().register("jev", build("jev"));
    const { state, root } = stateWithRoot(["jev", "lightgbm"]);

    const decision = applySpawn(
      state,
      root,
      spawn({ modelKind: "lightgbm" }),
      0,
      registry,
      RUN_ID,
    );
    expect(decision.state).toBe("rejected");
    expect(decision.code).toBe("FACTORY_ERROR");
  });
});
