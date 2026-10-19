/**
 * 节点侧的 model_kind:工具 schema 裁剪、提案预校验、spec dict 往返。
 *
 * 节点侧的校验是**便利**而非信任边界(真正的边界在控制器的 validateSpawn),
 * 但它决定模型究竟能看到哪个旋钮——白名单为空时参数整个不出现,避免模型
 * 反复尝试一个注定被拒的字段。
 */

import { describe, expect, it } from "vitest";
import { createAgentIdentity, createNodeBudget } from "@graph-agent/core";
import {
  GRAPH_TOOL_DEFINITIONS,
  ProposalCollector,
  SPAWN_TOOL,
  graphToolDefinitions,
} from "../src/graph-tools.js";
import { agentSpecFromDict, agentSpecToDict, createAgentSpec } from "../src/spec.js";

function spec(allowedModelKinds: readonly string[] = [], modelKind?: string) {
  return createAgentSpec({
    identity: createAgentIdentity({
      nodeId: "root",
      name: "Root Agent",
      role: "root",
      generation: 0,
    }),
    budget: createNodeBudget({ maxTotalTokens: 1000 }),
    instructions: "do things",
    role: "root",
    policy: { maxGeneration: 2, maxChildren: 4, allowedModelKinds },
    ...(modelKind !== undefined ? { modelKind } : {}),
  });
}

function collector(allowedModelKinds: readonly string[] = []) {
  return new ProposalCollector({
    spec: spec(allowedModelKinds),
    availableToolNames: new Set(["a"]),
  });
}

const SPAWN_ARGS = {
  role: "worker",
  objective: "do the thing",
  instructions: "instructions here",
};

function spawnSchema(defs: readonly { name: string; inputSchema: unknown }[]) {
  const def = defs.find((d) => d.name === SPAWN_TOOL)!;
  return def.inputSchema as {
    properties: Record<string, { enum?: readonly string[] }>;
  };
}

describe("graphToolDefinitions", () => {
  it("白名单为空时完全移除 model_kind 参数", () => {
    const props = spawnSchema(graphToolDefinitions([])).properties;
    expect("model_kind" in props).toBe(false);
    // 其余参数保持原样。
    expect("budget_share" in props).toBe(true);
    expect("priority" in props).toBe(true);
  });

  it("白名单非空时以 enum 暴露可选集合", () => {
    const props = spawnSchema(graphToolDefinitions(["jev", "lightgbm"])).properties;
    expect(props.model_kind?.enum).toEqual(["jev", "lightgbm"]);
  });

  it("不改动 spawn 以外的工具定义", () => {
    const defs = graphToolDefinitions(["jev"]);
    const others = defs.filter((d) => d.name !== SPAWN_TOOL);
    const baseline = GRAPH_TOOL_DEFINITIONS.filter((d) => d.name !== SPAWN_TOOL);
    expect(others).toEqual(baseline);
  });

  it("返回冻结的定义", () => {
    const defs = graphToolDefinitions(["jev"]);
    expect(Object.isFrozen(defs)).toBe(true);
    expect(Object.isFrozen(defs.find((d) => d.name === SPAWN_TOOL))).toBe(true);
  });

  it("不改动模块级的静态定义(无共享可变状态)", () => {
    graphToolDefinitions(["jev"]);
    const props = spawnSchema(GRAPH_TOOL_DEFINITIONS).properties;
    // 静态导出保留 model_kind 的通用声明,未被某次裁剪污染。
    expect(props.model_kind?.enum).toBeUndefined();
  });
});

describe("ProposalCollector — model_kind", () => {
  it("白名单内的 model_kind 进入提案", () => {
    const c = collector(["jev"]);
    const r = c.invoke(SPAWN_TOOL, { ...SPAWN_ARGS, model_kind: "jev" }, 0);
    expect(r.accepted).toBe(true);
    expect(c.spawns[0]!.modelKind).toBe("jev");
  });

  it("白名单为空时拒绝任何 model_kind", () => {
    const c = collector([]);
    const r = c.invoke(SPAWN_TOOL, { ...SPAWN_ARGS, model_kind: "jev" }, 0);
    expect(r.accepted).toBe(false);
    expect(r.output).toContain("model_kind not permitted");
    expect(c.spawns).toHaveLength(0);
  });

  it("拒绝白名单外的 model_kind", () => {
    const c = collector(["jev"]);
    const r = c.invoke(SPAWN_TOOL, { ...SPAWN_ARGS, model_kind: "lightgbm" }, 0);
    expect(r.accepted).toBe(false);
    expect(r.output).toContain("lightgbm");
  });

  it("省略 model_kind 时提案不含该键", () => {
    const c = collector(["jev"]);
    const r = c.invoke(SPAWN_TOOL, { ...SPAWN_ARGS }, 0);
    expect(r.accepted).toBe(true);
    expect("modelKind" in c.spawns[0]!).toBe(false);
  });

  it("拒绝非字符串的 model_kind", () => {
    const c = collector(["jev"]);
    expect(c.invoke(SPAWN_TOOL, { ...SPAWN_ARGS, model_kind: 7 }, 0).accepted).toBe(false);
  });

  it("被拒的提案不计入 maxChildren", () => {
    const c = collector([]);
    c.invoke(SPAWN_TOOL, { ...SPAWN_ARGS, model_kind: "jev" }, 0);
    // 上一次被拒,这次合法的 spawn 仍应被接受。
    expect(c.invoke(SPAWN_TOOL, { ...SPAWN_ARGS }, 1).accepted).toBe(true);
  });
});

describe("AgentSpec — modelKind 与 allowedModelKinds", () => {
  it("allowedModelKinds 默认为空", () => {
    expect(spec().policy.allowedModelKinds).toEqual([]);
  });

  it("去重并排序", () => {
    const s = spec(["llm", "jev", "llm"]);
    expect(s.policy.allowedModelKinds).toEqual(["jev", "llm"]);
  });

  it("dict 往返保留 modelKind 与 allowedModelKinds", () => {
    const s = spec(["jev", "llm"], "jev");
    const back = agentSpecFromDict(agentSpecToDict(s));
    expect(back.modelKind).toBe("jev");
    expect(back.policy.allowedModelKinds).toEqual(["jev", "llm"]);
  });

  it("未指定 modelKind 时 dict 不含该键", () => {
    expect("modelKind" in agentSpecToDict(spec(["jev"]))).toBe(false);
  });

  it("缺 allowedModelKinds 的旧 dict 可解析(视为空)", () => {
    // 本字段引入前写出的 checkpoint 必须仍能 rehydrate,否则旧 checkpoint
    // 无法 resume。
    const dict = agentSpecToDict(spec()) as Record<string, unknown>;
    delete (dict.policy as Record<string, unknown>).allowedModelKinds;
    expect(agentSpecFromDict(dict).policy.allowedModelKinds).toEqual([]);
  });

  it("allowedModelKinds 不是数组时抛错", () => {
    const dict = agentSpecToDict(spec()) as Record<string, unknown>;
    (dict.policy as Record<string, unknown>).allowedModelKinds = "jev";
    expect(() => agentSpecFromDict(dict)).toThrow(/must be an array/);
  });

  it("拒绝空白的 modelKind", () => {
    expect(() => spec([], "   ")).toThrow();
  });
});
