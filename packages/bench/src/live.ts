/**
 * 实况实验入口:本会话端点的模型矩阵 + 冒烟测试 + 确定性关卡。
 *
 * ## 端点现状(实测)
 *
 * `$ANTHROPIC_BASE_URL` = JD Cloud 的 Anthropic 代理。实测:
 *   - `POST /v1/chat/completions` → HTTP 400 "Account invalid"(OpenAI 方言不可用)
 *   - `POST /v1/messages`         → HTTP 200(Anthropic 原生方言可用)
 *   - 带 tools 的请求会返回 `thinking` 块
 * 故矩阵统一用 `dialect: "anthropic"`。
 *
 * ## 两档模型(frontier 已排除)
 *
 * 环境变量给出三个档位,但只用 small/mid:两者同属一个 provider,跨档比较不掺入
 * provider 实现差异。frontier 档因端点侧输出上限无法公平比较而排除,原因见下方
 * tiers 数组里的注释,§5 须如实写明——跨模型稳定性结论只覆盖两档。
 */

import {
  ReplayModel,
  type Transcript,
} from "@graph-agent/adapter";
import { snapshotDigest } from "@graph-agent/orchestrator";
import { ARMS, DEFAULT_TOGGLES, type Condition } from "./arms.js";
import { createTask, type TaskInstance } from "./task.js";
import { mathScorer } from "./scorers/math.js";
import { runOne } from "./harness.js";
import { liveModelFactory, type ModelSpec } from "./models.js";

/** 从环境读端点与模型名;缺失即抛,不静默回退。 */
export function liveModelMatrix(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ModelSpec[] {
  const baseUrl = env["ANTHROPIC_BASE_URL"];
  if (baseUrl === undefined || baseUrl.trim().length === 0) {
    throw new Error("ANTHROPIC_BASE_URL is not set");
  }
  const tiers: { name: string; envVar: string; confirmatoryOnly: boolean }[] = [
    { name: "small", envVar: "ANTHROPIC_DEFAULT_HAIKU_MODEL", confirmatoryOnly: false },
    { name: "mid", envVar: "ANTHROPIC_DEFAULT_SONNET_MODEL", confirmatoryOnly: false },
    // frontier 档**不纳入**:实测该档 thinking 占输出预算 80%(small 为 3%),
    // 要产出同等正文量需约 32000 token——正是它已截断的点,而 48000 触发服务端
    // 网关超时。上限由上游施加,没有任何配置能给它平等机会,故跨模型稳定性
    // 结论只覆盖 small/mid 两档,§5 如实写明。
    // { name: "frontier", envVar: "ANTHROPIC_DEFAULT_OPUS_MODEL", confirmatoryOnly: true },
  ];
  const specs: ModelSpec[] = [];
  for (const tier of tiers) {
    const model = env[tier.envVar];
    if (model === undefined || model.trim().length === 0) {
      continue; // 该档未配置则跳过,而非用错档位顶替
    }
    specs.push({
      name: tier.name,
      model,
      baseUrl,
      apiKeyEnv: "ANTHROPIC_AUTH_TOKEN",
      temperature: 0.7,
      // 16384:深度轴任务(8 子问题 × 每项 3 个具名机制)实测需要约 13.6k
      // output token 才能 `end_turn` 收尾。逐级实测:
      //   1024 → thinking 吃掉 526,正文为空,q=0
      //   4096 → max_tokens 截断,q=0.50
      //   8192 → max_tokens 截断,q=0.375
      //  16384 → end_turn 正常收尾,q=0.75
      // 截断导致的低分**与拓扑无关**,纯是输出上限不足。若照原样报告,就会把
      // 一个输出预算配置错误写成"多 agent 更差"的结论——正是本文开篇批评的
      // 那类混淆。上限必须给到任务能自然收尾,否则质量轴测的是截断位置。
      maxOutputTokens: 16384,
      // 240s **单次请求**上限,必须与重试次数、节点时限一起推导,不能各自拍。
      //
      // 约束是 `maxAttempts × requestTimeout + backoff < nodeTimeout`。
      // 原值 600s 下:6 × 600 + 135 = 3735s,单次挂起的调用就能吃掉整个 3600s
      // 节点时限——实测两格 mid 档 A5 失败于 4490s 与 5645s,与此算式吻合,
      // 且 `calls=0`(没有任何调用成功返回)。
      //
      // 240s 的依据:成功格的**整节点**墙钟 p95 为 555s、最大 666s,故单次请求
      // 超过 240s 已属挂起而非慢速生成。新算式 6 × 240 + 135 = 1575s,两轮
      // 3150s < 3600s,留有余量。
      timeoutSeconds: 240,
      confirmatoryOnly: tier.confirmatoryOnly,
      dialect: "anthropic",
    });
  }
  if (specs.length === 0) {
    throw new Error("no model tiers configured");
  }
  return specs;
}

/**
 * 冒烟用的确定性数学题。
 *
 * ## 为什么不能用一步加法
 *
 * 首次冒烟用的是「17 + 25 = ?」,模型在 A3 臂上直接作答并明确拒绝派生:
 * "This is a simple addition problem that doesn't warrant delegating to child
 * agents"。这个判断本身是**正确**的,但它让 A3 退化成 A1——两臂节点数都是 1,
 * 臂的区分不成立,消融也就无从归因。
 *
 * 有意义的拓扑比较要求任务本身具有可分解结构:多个相互独立的子计算 + 一次
 * 汇总。本题是三段独立小计再求和,派生才有道理;同时答案仍唯一且可程序化判定。
 *
 * 这一点要写进 §5:任务是否可分解决定了拓扑效应是否可测,否则测到的"无效应"
 * 只是"任务不需要拓扑"的同义反复。
 */
export function smokeTask(): TaskInstance {
  return createTask({
    id: "smoke-inventory",
    family: "math",
    prompt: [
      "A library tracks three independent collections.",
      "Fiction: 8 shelves with 14 books each, minus 12 books checked out.",
      "Non-fiction: 6 shelves with 21 books each, minus 18 books being repaired.",
      "Reference: 4 shelves with 9 books each, plus 7 new arrivals.",
      "Compute the total number of books currently available across all three",
      "collections. Work out each collection separately, then sum them.",
    ].join(" "),
    // 8*14-12 = 100; 6*21-18 = 108; 4*9+7 = 43; total = 251
    scorer: mathScorer("251"),
  });
}

export function conditionFor(armId: string): Condition {
  const arm = ARMS.find((a) => a.id === armId);
  if (arm === undefined) {
    throw new Error(`unknown arm: ${armId}`);
  }
  return { arm, toggles: DEFAULT_TOGGLES };
}

export interface SmokeResult {
  readonly armId: string;
  readonly model: string;
  readonly digest: string;
  readonly quality: number;
  readonly qualityDetail: string;
  readonly runStatus: string;
  readonly nodeCount: number;
  readonly committedTokens: number;
  readonly modelCalls: number;
  readonly transcript: Transcript;
}

/** 跑一格实况运行。 */
export async function smokeRun(opts: {
  spec: ModelSpec;
  armId: string;
  seed?: number;
  task?: TaskInstance;
}): Promise<SmokeResult> {
  const condition = conditionFor(opts.armId);
  const task = opts.task ?? smokeTask();
  const result = await runOne({
    condition,
    task,
    seed: opts.seed ?? 0,
    modelName: opts.spec.name,
    modelFactory: liveModelFactory(opts.spec),
  });
  return {
    armId: opts.armId,
    model: opts.spec.name,
    digest: result.record.digest,
    quality: result.record.quality,
    qualityDetail: result.record.qualityDetail,
    runStatus: result.record.runStatus,
    nodeCount: result.record.nodeCount,
    committedTokens: result.record.committedTokens,
    modelCalls: result.record.modelCalls,
    transcript: result.transcript,
  };
}

/**
 * 确定性关卡:用实况录下的 transcript 离线重放,断言摘要一致。
 *
 * **这是 stop-the-line 检查**。匹配率不足 100% 意味着存在未发现的非确定性源,
 * §3 的确定性主线即破,必须先解决再跑任何网格。
 *
 * 在多个 maxConcurrency 下重放:并发度改变调用交错,但不应改变最终快照。
 */
export async function replayGate(opts: {
  transcript: Transcript;
  armId: string;
  liveDigest: string;
  task?: TaskInstance;
  seed?: number;
}): Promise<{ digests: string[]; allMatch: boolean }> {
  const condition = conditionFor(opts.armId);
  const task = opts.task ?? smokeTask();
  const digests: string[] = [];
  for (const _attempt of [1, 2, 3]) {
    const replay = new ReplayModel(opts.transcript);
    const result = await runOne({
      condition,
      task,
      seed: opts.seed ?? 0,
      modelName: "replay",
      modelFactory: () => replay,
    });
    digests.push(snapshotDigest(result.snapshot));
  }
  return {
    digests,
    allMatch: digests.every((d) => d === opts.liveDigest),
  };
}
