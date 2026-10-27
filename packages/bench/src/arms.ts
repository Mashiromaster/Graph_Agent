/**
 * 实验臂:调研 §14 的五种配置,外加两个正交开关。
 *
 * ## 预算对等由构造保证
 *
 * 所有臂共享同一个 `maxTotalTokens`,且该上限由控制器的预算 ledger 在每条终止
 * 路径上强制(成功提交实际用量、失败/无效/异常提交整笔预留)。因此「同等预算下
 * 比较拓扑」这一前提不是靠事后筛掉超支运行得到的,而是由构造成立——**没有
 * 竞争框架能作此声明**,这是 §5 要前置的卖点。
 *
 * 单 agent 臂(A1)拿到与多 agent 臂完全相同的 token 上限:它不是「更便宜的
 * 基线」,而是「同样预算下不做分解」的对照。否则质量差异会与预算差异混淆。
 *
 * ## 两个开关为什么与五臂分开
 *
 * `depends_on` 的刚性数据流与 `message`/`skip_context` 的相关性路由是两种不同的
 * 机制(见 delivery.ts 的 mandatory 语义)。把它们混成一个"通讯"开关会让
 * claim (c) 的结论无法归因,故拆成 `fanIn` 与 `delivery` 两个正交维度。
 */

import { createNodeBudget, createAgentIdentity } from "@graph-agent/core";
import {
  createControllerPolicy,
  type ControllerPolicy,
} from "@graph-agent/orchestrator";
import { createAgentSpec, type AgentSpec } from "@graph-agent/node";
import { MESSAGE_TOOL, SKIP_CONTEXT_TOOL, SPAWN_TOOL } from "@graph-agent/node";

/**
 * 全部臂共享的 token 上限——预算对等的根据。
 *
 * 取 80000 而非初版的 20000:实测可分解任务族(六子问题技术简报)单次产出约
 * 4300 token,而派生臂的 root 还要承担「读回子节点产出 + 汇总」。20000 下
 * root 分到 10000,实测在 brief-consensus 上派生 3 个子节点后于汇总阶段
 * `token_budget_exceeded`,质量恒为 0。
 *
 * 那种 0 分**与拓扑无关**,纯是预算不足,若照原样报告就会把一个预算配置错误
 * 写成「多 agent 更差」的结论——正是本文开篇批评的那类混淆。预算对等要求的是
 * 各臂上限相同,不是上限小到让复杂臂做不完工作。
 */
export const SHARED_TOKEN_BUDGET = 160000;

/** 臂标识。 */
export type ArmId = "A1" | "A2" | "A3" | "A4" | "A5";

export interface ArmConfig {
  readonly id: ArmId;
  readonly label: string;
  /** 允许派生子节点。 */
  readonly spawn: boolean;
  /** 强制均匀 budgetShare 与固定 priority=0.5(等权)。 */
  readonly equalWeights: boolean;
  /** 允许跨代语义跳连。 */
  readonly skipContext: boolean;
  /** 允许显式 agent 间消息。 */
  readonly messages: boolean;
  /** 使用角色级可信度表(否则全为 1)。 */
  readonly roleTrust: boolean;
}

/**
 * 五臂。A1→A5 单调加入机制,故相邻两臂之差即该机制的边际效应。
 *
 * | 臂 | 增量 |
 * |----|------|
 * | A1 | 单 agent,不给 spawn 工具 |
 * | A2 | + 派生(等权:budgetShare 均匀、priority 恒 0.5) |
 * | A3 | + 模型自选 priority 与 budgetShare |
 * | A4 | + 跨代跳连 |
 * | A5 | + 显式消息 + 角色可信度 |
 */
export const ARMS: readonly ArmConfig[] = Object.freeze([
  Object.freeze({
    id: "A1" as const,
    label: "single agent",
    spawn: false,
    equalWeights: true,
    skipContext: false,
    messages: false,
    roleTrust: false,
  }),
  Object.freeze({
    id: "A2" as const,
    label: "equal-weight tree",
    spawn: true,
    equalWeights: true,
    skipContext: false,
    messages: false,
    roleTrust: false,
  }),
  Object.freeze({
    id: "A3" as const,
    label: "weighted tree",
    spawn: true,
    equalWeights: false,
    skipContext: false,
    messages: false,
    roleTrust: false,
  }),
  Object.freeze({
    id: "A4" as const,
    label: "fixed skip-connection graph",
    spawn: true,
    equalWeights: false,
    skipContext: true,
    messages: false,
    roleTrust: false,
  }),
  Object.freeze({
    id: "A5" as const,
    label: "dynamic weighted graph",
    spawn: true,
    equalWeights: false,
    skipContext: true,
    messages: true,
    roleTrust: true,
  }),
]);

/** 两个正交开关:claim (c) 的真正消融维度。 */
export interface Toggles {
  /** depends_on 结果传播(刚性 fan-in)。关闭则不建依赖边。 */
  readonly fanIn: boolean;
  /** 相关性路由的可选上下文投递。关闭则把注入预算设为最小值。 */
  readonly delivery: boolean;
}

export const DEFAULT_TOGGLES: Toggles = Object.freeze({ fanIn: true, delivery: true });

/** 一个完整实验配置 = 臂 + 开关。 */
export interface Condition {
  readonly arm: ArmConfig;
  readonly toggles: Toggles;
}

/** 配置的稳定短名,进 JSONL 与图表。 */
export function conditionKey(condition: Condition): string {
  const { arm, toggles } = condition;
  return `${arm.id}${toggles.fanIn ? "+fanin" : "-fanin"}${
    toggles.delivery ? "+deliv" : "-deliv"
  }`;
}

/** root agent 可用的图工具白名单。 */
export function graphToolsFor(arm: ArmConfig): string[] {
  const tools: string[] = [];
  if (arm.spawn) tools.push(SPAWN_TOOL);
  if (arm.messages) tools.push(MESSAGE_TOOL);
  if (arm.skipContext) tools.push(SKIP_CONTEXT_TOOL);
  return tools;
}

/**
 * 控制器策略。
 *
 * A1 把 `maxNodes` 设为 1 并收回 spawn 工具——双重保险:即便模型凭空编出一个
 * spawn 提案,控制器也会拒绝,故 A1 的"单 agent"性质由构造保证而非靠模型配合。
 *
 * `delivery` 关闭时把注入预算压到 1 token:这比加一个布尔开关更可取,因为它走
 * 的是与开启时**完全相同的代码路径**,只是预算不足以容纳任何一条投递。对照组
 * 与实验组的差异因此严格限于预算,不掺入分支差异。刚性 fan-in 仍会被
 * mandatory 语义尝试投递,但同样受预算约束而落空——这正是"关闭投递"的含义。
 */
export function policyFor(condition: Condition): ControllerPolicy {
  const { arm, toggles } = condition;
  return createControllerPolicy({
    maxNodes: arm.spawn ? 8 : 1,
    maxEdges: 32,
    maxGeneration: arm.spawn ? 2 : 1,
    maxChildrenPerNode: 3,
    maxTotalTokens: SHARED_TOKEN_BUDGET,
    maxConcurrency: 4,
    // 深度轴任务的单节点产出实测约 26k 字符,远超默认的 16000。超限会让
    // validateResult 返回 MALFORMED_RESULT → fail-closed 提交整笔预留、节点
    // 置 FAILED,而评分器拿到的仍是那段被图判为无效的文本——于是 JSONL 里
    // 出现 q=0.875 配 status=failed 的自相矛盾行。
    // 上限必须容纳任务的正常产出,否则测的是"有没有超长",不是拓扑。
    maxTextLength: 64000,
    contextInjectionTokenBudget: toggles.delivery ? 2000 : 1,
    maxDeliveriesPerNode: 8,
    contextTopK: 16,
  });
}

/** root agent 的指令文本,按臂裁剪可用机制的说明。 */
export function rootInstructionsFor(arm: ArmConfig): string {
  if (!arm.spawn) {
    return [
      "You are a single agent working alone.",
      "Solve the task directly and completely.",
      "State your final answer explicitly on the last line, prefixed with 'Answer:'.",
    ].join(" ");
  }
  const lines = [
    "You are an orchestrator agent that may delegate to child agents.",
    `Use ${SPAWN_TOOL} to propose a child when decomposition genuinely reduces risk or effort.`,
  ];
  if (arm.equalWeights) {
    lines.push(
      "Give every child the same priority (0.5) and an equal share of your budget.",
    );
  } else {
    lines.push(
      "Set each child's priority and budget_share to reflect how much that subtask matters.",
    );
  }
  if (arm.skipContext) {
    lines.push(
      `Use ${SKIP_CONTEXT_TOOL} to let a child see an ancestor's findings directly.`,
    );
  }
  if (arm.messages) {
    lines.push(`Use ${MESSAGE_TOOL} to pass a finding to a sibling that has not run yet.`);
  }
  lines.push(
    "After delegating, synthesize the children's findings into one final answer.",
    "State your final answer explicitly on the last line, prefixed with 'Answer:'.",
  );
  return lines.join(" ");
}

/** root agent 的 spec。 */
export function rootSpecFor(condition: Condition, nodeId = "root"): AgentSpec {
  const { arm } = condition;
  return createAgentSpec({
    identity: createAgentIdentity({
      nodeId,
      name: "Root",
      role: "orchestrator",
      generation: 0,
    }),
    instructions: rootInstructionsFor(arm),
    role: "orchestrator",
    budget: createNodeBudget({
      maxTurns: arm.spawn ? 6 : 4,
      // maxToolCalls 需 ≥ maxChildren,否则模型刚派生完就没有调用额度去汇总。
      maxToolCalls: arm.spawn ? 8 : 2,
      // 派生臂的 root 取全局上限的 **3/4** 而非 1/2。
      //
      // 原因是子节点份额的乘法效应:子节点分到的是
      // `floor(root.allocationTokens * budgetShare)`,budgetShare 实测 0.2–0.33,
      // 于是 root=40000 时子节点只有 8000–13200——而深度轴任务里每个子节点要
      // 产出约 10–14k output token。结果是 3 个子节点全部
      // `token_budget_exceeded`,而 root 自己成功:记录里出现 nodes=4、
      // failureCount=3、q=0.625 却 status=failed 的行。
      //
      // 那种失败**与拓扑无关**,纯是份额算术把子节点饿死。root 取 3/4 使
      // budgetShare=0.25 的子节点拿到 15000,刚过可行线。两臂的**全局**上限
      // 仍相同(policyFor 的 maxTotalTokens),预算对等不受影响。
      maxTotalTokens: arm.spawn
        ? Math.floor((SHARED_TOKEN_BUDGET * 3) / 4)
        : SHARED_TOKEN_BUDGET,
      // 900s:单节点产出约 10k token 实测耗时 138s,而派生臂的 root 要跑两轮
      // (派生 + 汇总)并在第二轮读回子节点产出,实测 180s 恰好卡死在上限上
      // → 超时转为结构化 FAILED、提交整笔预留、q=0。那种 0 分同样与拓扑无关。
      // 该端点吞吐约 70–80 token/s,长产出本就慢,上限必须留足余量。
      timeoutSeconds: 900,
    }),
    policy: {
      maxGeneration: arm.spawn ? 2 : 0,
      maxChildren: arm.spawn ? 3 : 0,
      allowDirectMessages: arm.messages,
      allowSkipContext: arm.skipContext,
    },
  });
}

/** 枚举全部实验配置:5 臂 × 两开关的受控组合。 */
export function enumerateConditions(): Condition[] {
  const conditions: Condition[] = [];
  for (const arm of ARMS) {
    conditions.push({ arm, toggles: DEFAULT_TOGGLES });
  }
  // claim (c) 的消融只在最丰富的臂(A5)上做:在 A1 上关投递没有意义
  // (它没有子节点,本就无投递),在中间臂上做会让配置数翻倍而信息增量很小。
  const a5 = ARMS[ARMS.length - 1]!;
  conditions.push({ arm: a5, toggles: { fanIn: false, delivery: true } });
  conditions.push({ arm: a5, toggles: { fanIn: true, delivery: false } });
  return conditions;
}
