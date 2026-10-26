/**
 * harness 契约测试,全部由 ScriptedModel 驱动 → 完全离线、确定。
 *
 * 关键验证:同一组脚本响应 + 同一配置,harness 产出**逐字节相同**的 JSONL。
 * 这是把 harness 本身纳入「运行时贡献零熵」这一声明的覆盖范围——否则即便运行时
 * 确定,实验脚本仍可能引入熵(例如把 Date.now 写进记录),而那同样会毁掉复现性。
 */

import { describe, expect, it } from "vitest";
import {
  ScriptedModel,
  createModelResponse,
  createToolCall,
  type ModelAdapter,
} from "@graph-agent/adapter";
import { createUsage } from "@graph-agent/core";
import { SPAWN_TOOL } from "@graph-agent/node";
import { createTrustTable } from "@graph-agent/orchestrator";
import { ARMS, DEFAULT_TOGGLES, conditionKey, type Condition } from "../src/arms.js";
import { createTask } from "../src/task.js";
import { mathScorer } from "../src/scorers/math.js";
import { runOne, toJsonLine, type ModelFactory } from "../src/harness.js";

const arm = (id: string) => ARMS.find((a) => a.id === id)!;

function condition(id: string, toggles = DEFAULT_TOGGLES): Condition {
  return { arm: arm(id), toggles };
}

const task = createTask({
  id: "math-1",
  family: "math",
  prompt: "What is 17 plus 25?",
  scorer: mathScorer("42"),
});

/** 单 agent:一轮直接作答。 */
function soloModel(answer: string): ModelAdapter {
  return new ScriptedModel([
    createModelResponse({
      content: `Let me work it out. Answer: ${answer}`,
      usage: createUsage({ inputTokens: 20, outputTokens: 10 }),
    }),
  ]);
}

/** 可控时钟,使 latencyMs 确定。 */
function fakeClock(): () => number {
  let t = 0;
  return () => {
    t += 5;
    return t;
  };
}

describe("harness on a single-agent arm", () => {
  it("records a scored run with budget and topology observables", async () => {
    const factory: ModelFactory = () => soloModel("42");
    const { record } = await runOne({
      condition: condition("A1"),
      task,
      seed: 0,
      modelName: "scripted",
      modelFactory: factory,
      wallClock: fakeClock(),
    });

    expect(record.armId).toBe("A1");
    expect(record.quality).toBe(1);
    expect(record.runStatus).toBe("succeeded");
    expect(record.nodeCount).toBe(1);
    expect(record.maxDepth).toBe(0);
    expect(record.failureCount).toBe(0);
    expect(record.modelCalls).toBe(1);
    expect(record.committedTokens).toBeGreaterThan(0);
    expect(record.committedTokens).toBeLessThanOrEqual(record.limitTokens);
    expect(record.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(record.latencyMs).toBe(5);
  });

  it("scores a wrong answer as zero without failing the run", async () => {
    const { record } = await runOne({
      condition: condition("A1"),
      task,
      seed: 0,
      modelName: "scripted",
      modelFactory: () => soloModel("41"),
      wallClock: fakeClock(),
    });
    expect(record.quality).toBe(0);
    expect(record.qualityDetail).toContain("expected 42");
    expect(record.runStatus).toBe("succeeded");
  });

  it("is byte-identical across repeated runs with the same script", async () => {
    const run = () =>
      runOne({
        condition: condition("A1"),
        task,
        seed: 7,
        modelName: "scripted",
        modelFactory: () => soloModel("42"),
        wallClock: fakeClock(),
      });
    const a = await run();
    const b = await run();
    expect(toJsonLine(a.record)).toBe(toJsonLine(b.record));
  });
});

describe("harness on a spawning arm", () => {
  /** root 派生两个子节点后收尾;子节点各自作答。 */
  function spawningFactory(): ModelFactory {
    return ({ nodeId }) => {
      if (nodeId === "root") {
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
                  role: "worker",
                  objective: "add the first pair",
                  instructions: "compute 17 plus 25",
                  tool_names: [],
                  priority: 0.5,
                  budget_share: 0.2,
                },
              }),
              createToolCall({
                id: "tc-2",
                name: SPAWN_TOOL,
                arguments: {
                  proposal_id: "sp-b",
                  generation: 1,
                  role: "reducer",
                  objective: "state the final answer",
                  instructions: "report the sum",
                  tool_names: [],
                  priority: 0.5,
                  budget_share: 0.2,
                },
              }),
            ],
            usage: createUsage({ inputTokens: 30, outputTokens: 15 }),
          }),
          createModelResponse({
            content: "Children agree. Answer: 42",
            usage: createUsage({ inputTokens: 25, outputTokens: 10 }),
          }),
        ]);
      }
      return new ScriptedModel([
        createModelResponse({
          content: "The sum is 42",
          usage: createUsage({ inputTokens: 12, outputTokens: 6 }),
        }),
      ]);
    };
  }

  it("materializes children and keeps the budget within the shared limit", async () => {
    const { record } = await runOne({
      condition: condition("A3"),
      task,
      seed: 0,
      modelName: "scripted",
      modelFactory: spawningFactory(),
      wallClock: fakeClock(),
      trustTable: createTrustTable(),
    });
    expect(record.nodeCount).toBe(3);
    expect(record.maxDepth).toBe(1);
    expect(record.proposalCount).toBe(2);
    expect(record.rejectedCount).toBe(0);
    expect(record.quality).toBe(1);
    expect(record.committedTokens).toBeLessThanOrEqual(record.limitTokens);
  });

  it("delivers dependency context when fanIn is on and none when off", async () => {
    const on = await runOne({
      condition: condition("A3", { fanIn: true, delivery: true }),
      task,
      seed: 0,
      modelName: "scripted",
      modelFactory: spawningFactory(),
      wallClock: fakeClock(),
    });
    const off = await runOne({
      condition: condition("A3", { fanIn: false, delivery: true }),
      task,
      seed: 0,
      modelName: "scripted",
      modelFactory: spawningFactory(),
      wallClock: fakeClock(),
    });
    // fanIn 开启时 reducer 多收到一条依赖投递。
    expect(on.record.deliveredCount).toBeGreaterThan(off.record.deliveredCount);
    expect(off.record.deliveredCount).toBe(0);
    // 依赖边使边数增加。
    expect(on.record.edgeCount).toBeGreaterThan(off.record.edgeCount);
  });

  it("suppresses delivery when the injection budget is closed", async () => {
    const closed = await runOne({
      condition: condition("A3", { fanIn: true, delivery: false }),
      task,
      seed: 0,
      modelName: "scripted",
      modelFactory: spawningFactory(),
      wallClock: fakeClock(),
    });
    // 投递关闭:依赖边仍在(拓扑不变),但没有内容进入上下文。
    expect(closed.record.deliveredCount).toBe(0);
    expect(closed.record.edgeCount).toBeGreaterThan(0);
  });
});

describe("A1 is single-agent by construction", () => {
  it("rejects a spawn proposal because maxNodes is 1", async () => {
    // 即便模型凭空编出 spawn 提案,控制器也必须拒绝——A1 的单 agent 性质
    // 由策略保证,而不是靠模型配合。
    const factory: ModelFactory = () =>
      new ScriptedModel([
        createModelResponse({
          content: null,
          toolCalls: [
            createToolCall({
              id: "tc-1",
              name: SPAWN_TOOL,
              arguments: {
                proposal_id: "sp-x",
                generation: 1,
                role: "worker",
                objective: "o",
                instructions: "i",
                tool_names: [],
                priority: 0.5,
                budget_share: 0.2,
              },
            }),
          ],
          usage: createUsage({ inputTokens: 10, outputTokens: 5 }),
        }),
        createModelResponse({
          content: "Answer: 42",
          usage: createUsage({ inputTokens: 10, outputTokens: 5 }),
        }),
      ]);

    const { record } = await runOne({
      condition: condition("A1"),
      task,
      seed: 0,
      modelName: "scripted",
      modelFactory: factory,
      wallClock: fakeClock(),
    });
    // 纵深防御:A1 的 spec.policy 设 maxChildren/maxGeneration = 0,故节点侧的
    // ProposalCollector 先行拒绝,提案根本不会进入 AgentResult——因此
    // rejectedCount 为 0 而非 >0。控制器侧的 maxNodes=1 是第二道闸,只有在
    // 节点侧被绕过时才会触发。无论哪道生效,结论相同:A1 恒为单节点。
    expect(record.nodeCount).toBe(1);
    expect(record.proposalCount).toBe(0);
    expect(record.maxDepth).toBe(0);
    expect(record.runStatus).toBe("succeeded");
  });
});

describe("conditionKey", () => {
  it("encodes arm and both toggles", () => {
    expect(conditionKey(condition("A5", { fanIn: true, delivery: false }))).toBe(
      "A5+fanin-deliv",
    );
  });
});
