/**
 * Phase-1 关卡:**运行时贡献零熵**。
 *
 * 本运行时的确定性是以模型为条件的。temperature > 0 的实况运行不是 bit-identical,
 * 因此可检验的命题不是「两次实况运行相同」,而是:
 *
 *   给定同一组模型响应,最终快照摘要与并发度、调度顺序、完成先后无关地逐字节相同。
 *
 * 测法:用 RecordingModel 把一次真实 AgentNode 全栈运行(root 派生两个子节点)的模型
 * 响应录下来,再在 **3 个 maxConcurrency × 3 种人为打乱的完成顺序** 共 9 种条件下用
 * ReplayModel 重放同一份 transcript,断言 9 次得到同一个 snapshotDigest。
 *
 * 这里刻意走 packages/node 的真实 AgentNode(而不是 orchestrator 测试里的 stub
 * runner):模型适配器、turn loop、工具分派、提案收集、ingest 校验、预算 ledger 全链
 * 在内,才能排除「只有 stub 路径是确定的」这种可能。packages/node 以 devDependency
 * 持有 orchestrator,是唯一能同时 import 两层的测试位置。
 *
 * 失败含义:9 个摘要不全相同,即存在未发现的非确定性源,确定性主线即破。
 */

import {
  createAgentIdentity,
  createAgentInput,
  createNodeBudget,
  createUsage,
  type AgentResult,
} from "@graph-agent/core";
import {
  RecordingModel,
  ReplayModel,
  ScriptedModel,
  createModelResponse,
  createToolCall,
  type ModelAdapter,
  type Transcript,
} from "@graph-agent/adapter";
import {
  GraphController,
  NodeState,
  RunStatus,
  createControllerPolicy,
  snapshotDigest,
  type NodeFactory,
  type NodeRunner,
  type RunSnapshot,
} from "@graph-agent/orchestrator";
import { describe, expect, it } from "vitest";
import { createAgentSpec, type AgentSpec as NodeAgentSpec } from "../src/spec.js";
import { SPAWN_TOOL } from "../src/graph-tools.js";
import { AgentNode } from "../src/agent-node.js";

const RUN_ID = "det-run";

/** Root 的 spec:允许派生两个子节点,带 spawn 图工具。 */
function rootSpec() {
  return createAgentSpec({
    identity: createAgentIdentity({
      nodeId: "root",
      name: "Root",
      role: "orchestrator",
      generation: 0,
    }),
    instructions: "decompose the task",
    role: "orchestrator",
    budget: createNodeBudget({ maxTurns: 3, maxToolCalls: 4, maxTotalTokens: 4000 }),
    policy: { maxGeneration: 2, maxChildren: 2 },
  });
}

/** 子节点 spec:无图工具,直接作答。 */
function childSpec(nodeId: string, role: string) {
  return createAgentSpec({
    identity: createAgentIdentity({
      nodeId,
      name: `${role} Agent`,
      role,
      generation: 1,
      parentNodeId: "root",
    }),
    instructions: "do the assigned work",
    role,
    budget: createNodeBudget({ maxTurns: 2, maxToolCalls: 1, maxTotalTokens: 1000 }),
  });
}

/**
 * Root 的脚本化模型:第一轮发两个 spawn 工具调用,第二轮收尾作答。
 * 子节点的模型:一轮直接作答。两者的响应都会被 RecordingModel 录下。
 */
function rootModel(): ModelAdapter {
  return new ScriptedModel([
    createModelResponse({
      content: null,
      toolCalls: [
        createToolCall({
          id: "tc-1",
          name: SPAWN_TOOL,
          arguments: {
            proposal_id: "sp-a",
            generation: 1,
            role: "researcher",
            objective: "gather the facts",
            instructions: "collect sources",
            tool_names: [],
            // 两个子节点**同优先级**:强制走 (−priority, nodeId) 里的 nodeId 断连分支,
            // 即确定性真正依赖的那条路径。若断连改为随机,摘要立刻发散。
            priority: 0.5,
            budget_share: 0.3,
          },
        }),
        createToolCall({
          id: "tc-2",
          name: SPAWN_TOOL,
          arguments: {
            proposal_id: "sp-b",
            generation: 1,
            role: "writer",
            objective: "draft the answer",
            instructions: "write it up",
            tool_names: [],
            priority: 0.5,
            budget_share: 0.3,
          },
        }),
      ],
      usage: createUsage({ inputTokens: 40, outputTokens: 20 }),
    }),
    createModelResponse({
      content: "delegated to two children",
      usage: createUsage({ inputTokens: 30, outputTokens: 10 }),
    }),
  ]);
}

function childModel(answer: string): ModelAdapter {
  return new ScriptedModel([
    createModelResponse({
      content: answer,
      usage: createUsage({ inputTokens: 15, outputTokens: 8 }),
    }),
  ]);
}

/** 按子节点物化顺序分配脚本答案,保证录制/重放时同一子节点拿到同一脚本。 */
const CHILD_ANSWERS = ["facts gathered", "draft complete"] as const;

/**
 * 构造一个 NodeFactory。
 *
 * @param wrap      把每个子模型包一层(录制时包 RecordingModel,重放时换 ReplayModel)
 * @param delayPlan 完成顺序扰动:第 i 个物化的子节点延迟 delayPlan[i] 个宏任务
 */
function makeFactory(
  wrap: (inner: ModelAdapter) => ModelAdapter,
  delayPlan: readonly number[] = [],
): NodeFactory {
  let materialized = 0;
  return {
    create({ spec, toolNames }) {
      const nodeId = spec.identity.nodeId;
      const isRoot = nodeId === "root";
      const ordinal = isRoot ? -1 : materialized++;
      const model = wrap(
        isRoot ? rootModel() : childModel(CHILD_ANSWERS[ordinal % CHILD_ANSWERS.length]!),
      );
      if (toolNames.length > 0) {
        throw new Error("determinism fixture exposes no local tools");
      }
      const inner = new AgentNode({ spec: spec as NodeAgentSpec, model });
      if (isRoot || delayPlan.length === 0) return inner;
      const delay = delayPlan[ordinal % delayPlan.length] ?? 0;
      return delayedRunner(inner, delay);
    },
  };
}

/** 把一个 runner 的完成推迟 n 个宏任务,用来人为改变完成先后。 */
function delayedRunner(inner: NodeRunner, macrotasks: number): NodeRunner {
  return {
    spec: inner.spec,
    run: async (input, signal): Promise<AgentResult> => {
      for (let i = 0; i < macrotasks; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      return inner.run(input, signal);
    },
  };
}

async function runOnce(
  wrap: (inner: ModelAdapter) => ModelAdapter,
  opts: { maxConcurrency: number; delayPlan?: readonly number[] },
): Promise<RunSnapshot> {
  const factory = makeFactory(wrap, opts.delayPlan ?? []);
  const spec = rootSpec();
  const runner = factory.create({ spec, toolNames: [] });
  const controller = new GraphController(
    factory,
    createControllerPolicy({
      maxNodes: 8,
      maxEdges: 16,
      maxGeneration: 2,
      maxChildrenPerNode: 2,
      maxTotalTokens: 20000,
      maxConcurrency: opts.maxConcurrency,
    }),
    () => 0,
  );
  await controller.createRun(
    RUN_ID,
    spec,
    runner,
    createAgentInput({ task: "answer the question", context: [], sessionId: RUN_ID }),
  );
  return controller.runUntilIdle(RUN_ID);
}

describe("runtime contributes zero entropy", () => {
  it("replays one transcript to an identical digest across concurrency x completion order", async () => {
    // ── 1. 录制一次基准运行 ──────────────────────────────────────────────
    const recorders: RecordingModel[] = [];
    const baseline = await runOnce(
      (inner) => {
        const rec = new RecordingModel(inner);
        recorders.push(rec);
        return rec;
      },
      { maxConcurrency: 2 },
    );

    expect(baseline.status).toBe(RunStatus.SUCCEEDED);
    expect(baseline.nodes).toHaveLength(3); // root + 2 children
    expect(baseline.nodes.every((n) => n.state === NodeState.SUCCEEDED)).toBe(true);

    // 合并各节点的 transcript 成一份(键分组,跨键取用顺序不受约束)。
    const merged: Transcript = Object.freeze({
      entries: Object.freeze(recorders.flatMap((r) => [...r.transcript().entries])),
    });
    expect(merged.entries.length).toBeGreaterThanOrEqual(4); // root 2 轮 + 2 子节点各 1 轮

    const baselineDigest = snapshotDigest(baseline);

    // ── 2. 在 9 种并发/完成顺序条件下重放同一份 transcript ───────────────
    // delayPlan 改变子节点的完成先后:[0,0] 同时完成,[3,0] 第一个后到,[0,3] 第二个后到。
    const delayPlans: readonly (readonly number[])[] = [
      [0, 0],
      [3, 0],
      [0, 3],
    ];
    const concurrencies = [1, 2, 4];

    const digests: string[] = [];
    for (const maxConcurrency of concurrencies) {
      for (const delayPlan of delayPlans) {
        const replay = new ReplayModel(merged);
        const snapshot = await runOnce(() => replay, { maxConcurrency, delayPlan });
        expect(snapshot.status).toBe(RunStatus.SUCCEEDED);
        digests.push(snapshotDigest(snapshot));
      }
    }

    // ── 3. 关卡断言:全部 9 次 + 基准,摘要唯一 ──────────────────────────
    expect(digests).toHaveLength(9);
    expect(new Set(digests).size).toBe(1);
    expect(digests[0]).toBe(baselineDigest);
  });

  it("fails closed when a replay diverges from the recorded request set", async () => {
    // 录一次,然后用一份被截断的 transcript 重放 → 必须抛 ReplayMissError 而非
    // 悄悄用兜底响应把运行走完。这保证上一个测试里的「摘要相同」不可能是
    // 「重放缺失被掩盖后恰好一致」。
    const recorders: RecordingModel[] = [];
    await runOnce(
      (inner) => {
        const rec = new RecordingModel(inner);
        recorders.push(rec);
        return rec;
      },
      { maxConcurrency: 2 },
    );
    const all = recorders.flatMap((r) => [...r.transcript().entries]);
    const truncated: Transcript = Object.freeze({
      entries: Object.freeze(all.slice(0, 1)),
    });

    const replay = new ReplayModel(truncated);
    const snapshot = await runOnce(() => replay, { maxConcurrency: 2 });
    // 节点内部把异常转为结构化 FAILED 结果,故运行以 FAILED 收敛而非抛出。
    expect(snapshot.status).toBe(RunStatus.FAILED);
  });
});
