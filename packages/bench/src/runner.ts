/**
 * 实验运行器:遍历分层矩阵,逐次运行并落盘 JSONL + transcript。
 *
 * ## 分层(计划已确认)
 *
 * 小/中模型跑完整 7 配置网格;前沿模型只跑确认子集 A1/A3/A5。分层是**显式的
 * 设计决策**,连成本表一并写进 §5——不让审稿人自己从行数里推断覆盖范围。
 * `plannedCells` 在运行前就能算出总格数与被跳过的组合,便于在论文里如实报告。
 *
 * ## 为什么逐次落盘而非跑完一次性写出
 *
 * 实况实验会跑数小时并可能中途失败(限流、网络、配额)。逐行 append 使已完成
 * 的工作不丢失,且 `completedKeys` 能让重启后跳过已完成的格子——这是幂等重入,
 * 不是断点续跑的近似。
 *
 * ## transcript 为什么必须留
 *
 * 它让审稿人零 API 成本复算每个数字,并自行验证「运行时贡献零熵」。这是本工作
 * 最强的单项严谨性资产,故按格子单独存盘而非只留内存。
 */

import { ReplayModel, type Transcript } from "@graph-agent/adapter";
import {
  applyTrustObservations,
  loadTrustTable,
  type TrustStorage,
  type TrustTable,
} from "@graph-agent/orchestrator";
import { conditionKey, enumerateConditions, type Condition } from "./arms.js";
import { runOne, toJsonLine, type ModelFactory, type RunRecord } from "./harness.js";
import { rewardObservations } from "./reward.js";
import type { TaskInstance } from "./task.js";
import type { ModelSpec } from "./models.js";

/** 确认子集:前沿模型只跑这三臂。 */
const CONFIRMATORY_ARMS = new Set(["A1", "A3", "A5"]);

/** 一个待运行的格子。 */
export interface Cell {
  readonly model: ModelSpec;
  readonly condition: Condition;
  readonly task: TaskInstance;
  readonly seed: number;
}

/** 格子的稳定标识,用于幂等跳过。 */
export function cellKey(cell: Cell): string {
  return `${cell.model.name}::${conditionKey(cell.condition)}::${cell.task.id}::${cell.seed}`;
}

/**
 * 枚举分层矩阵的全部格子。
 *
 * 前沿模型(confirmatoryOnly)只取 A1/A3/A5 且丢弃开关消融——后者的信息增量
 * 来自同一模型内的对照,跨模型重复做它只增成本不增结论。
 */
export function plannedCells(input: {
  models: readonly ModelSpec[];
  tasks: readonly TaskInstance[];
  seeds: readonly number[];
  confirmatorySeeds?: readonly number[];
}): Cell[] {
  const all = enumerateConditions();
  const cells: Cell[] = [];
  for (const model of input.models) {
    const conditions = model.confirmatoryOnly
      ? all.filter(
          (c) =>
            CONFIRMATORY_ARMS.has(c.arm.id) && c.toggles.fanIn && c.toggles.delivery,
        )
      : all;
    const seeds = model.confirmatoryOnly
      ? (input.confirmatorySeeds ?? input.seeds)
      : input.seeds;
    for (const condition of conditions) {
      for (const task of input.tasks) {
        for (const seed of seeds) {
          cells.push({ model, condition, task, seed });
        }
      }
    }
  }
  return cells;
}

/** 落盘接口(仅需 append 与读取,便于测试注入内存实现)。 */
export interface RunSink {
  appendLine(path: string, line: string): Promise<void>;
  atomicWrite(path: string, bytes: string): Promise<void>;
  read(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
}

export interface RunnerOptions {
  readonly cells: readonly Cell[];
  /** 由 ModelSpec 构造实况或脚本化工厂;测试里注入脚本化版本。 */
  readonly factoryFor: (model: ModelSpec) => ModelFactory;
  readonly sink: RunSink;
  /** JSONL 输出路径。 */
  readonly recordsPath?: string;
  /** transcript 目录前缀。 */
  readonly transcriptDir?: string;
  /** trust 表存储;提供则每格运行后按 reward 更新(跨运行学习)。 */
  readonly trustStorage?: TrustStorage;
  /** EMA 步长。 */
  readonly trustAlpha?: number;
  /** 已完成的格子键,用于幂等跳过。 */
  readonly completedKeys?: ReadonlySet<string>;
  /** 每格结束后的回调,便于打印进度。 */
  readonly onProgress?: (done: number, total: number, record: RunRecord) => void;
  readonly wallClock?: () => number;
  /**
   * 每格之间的固定间隔(毫秒)。与 `tokensPerMinute` 二者取较大的等待量。
   *
   * 默认 0(离线测试不等待);实况运行由调用方显式给值。
   */
  readonly pacingMs?: number;
  /**
   * 端点的**每分钟 token** 配额。给定则按上一格的实际用量自适应节流。
   *
   * 固定间隔不够用:实测 429 的原因是 `tokens limit for minute`——按 token 计费
   * 的滑动窗口,而非请求频率。各格用量相差两倍以上(small 约 19.6k、mid 约
   * 36.1k、A5 派生格约 43.6k),同一个常数间隔对轻格浪费、对重格仍然超限。
   *
   * 实测 small 档持续抽取约 5639 tok/min、mid 约 8105 tok/min,而探测显示
   * 约 4458 tok/min 可持续不触发 429——mid 档超了近一倍,这正是 A5 mid 格
   * 连续失败的原因(最后 12 格失败 8 格)。
   *
   * 自适应公式:上一格用了 T 个 token,则该格应占用 T / tokensPerMinute 分钟的
   * 窗口;已经花掉的墙钟时间可以抵扣,只补足差额。这样重格多等、轻格少等,
   * 且 frontier 档(更重)自动获得更长间隔,无需另调常数。
   */
  readonly tokensPerMinute?: number;
  /** 注入的 sleep,便于测试不真的等待。 */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface RunnerSummary {
  readonly attempted: number;
  readonly succeeded: number;
  readonly skipped: number;
  readonly failed: readonly { cellKey: string; error: string }[];
  readonly records: readonly RunRecord[];
}

// 路径相对于 sink 的根(FileStorage 把一切解析到 rootDir 之下),故这里**不带**
// `results/` 前缀——否则传入 rootDir: "results" 会拼出 results/results/。
const DEFAULT_RECORDS_PATH = "records.jsonl";
const DEFAULT_TRANSCRIPT_DIR = "transcripts";

/**
 * 顺序执行全部格子。
 *
 * 刻意串行:并发会让多个实验进程同时打同一个 provider 的限流,且 trust 表的
 * 跨运行更新本身是有序依赖(第 N 次运行读到的是前 N−1 次的累积)。实验总时长
 * 由 API 延迟主导,串行的代价可接受,换来的是可解释的更新序。
 *
 * 单格失败不中止整轮:记录错误并继续,最后在 summary 里汇总。否则一次限流就会
 * 丢掉整晚的运行。
 */
export async function runGrid(opts: RunnerOptions): Promise<RunnerSummary> {
  const recordsPath = opts.recordsPath ?? DEFAULT_RECORDS_PATH;
  const transcriptDir = opts.transcriptDir ?? DEFAULT_TRANSCRIPT_DIR;
  const completed = opts.completedKeys ?? new Set<string>();
  const alpha = opts.trustAlpha ?? 0.2;
  const pacingMs = opts.pacingMs ?? 0;
  const tokensPerMinute = opts.tokensPerMinute ?? 0;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let executed = 0;
  // 上一格的用量与耗时,用于自适应节流(见 tokensPerMinute 的说明)。
  let lastTokens = 0;
  let lastElapsedMs = 0;

  const records: RunRecord[] = [];
  const failed: { cellKey: string; error: string }[] = [];
  let skipped = 0;
  let done = 0;

  for (const cell of opts.cells) {
    const key = cellKey(cell);
    if (completed.has(key)) {
      skipped += 1;
      continue;
    }
    // 格间节流:在**每次真正执行之前**等待(跳过的格不等待),避免把配额打穿。
    if (executed > 0) {
      // 按 token 配额自适应:上一格用了 T 个 token,就该占用
      // T / tokensPerMinute 分钟的窗口;已花掉的墙钟可抵扣,只补差额。
      const quotaWaitMs =
        tokensPerMinute > 0
          ? Math.max(0, (lastTokens / tokensPerMinute) * 60_000 - lastElapsedMs)
          : 0;
      const waitMs = Math.max(pacingMs, quotaWaitMs);
      if (waitMs > 0) {
        await sleep(waitMs);
      }
    }
    executed += 1;
    try {
      let trustTable: TrustTable | undefined;
      if (opts.trustStorage !== undefined && cell.condition.arm.roleTrust) {
        trustTable = await loadTrustTable(opts.trustStorage);
      }
      const result = await runOne({
        condition: cell.condition,
        task: cell.task,
        seed: cell.seed,
        modelName: cell.model.name,
        modelFactory: opts.factoryFor(cell.model),
        ...(trustTable !== undefined ? { trustTable } : {}),
        ...(opts.wallClock !== undefined ? { wallClock: opts.wallClock } : {}),
      });

      await opts.sink.appendLine(recordsPath, toJsonLine(result.record));
      await opts.sink.atomicWrite(
        `${transcriptDir}/${key}.json`,
        serializeTranscript(result.transcript),
      );

      // 跨运行 trust 更新:只在启用角色可信度的臂上做,否则会把对照臂的观测
      // 也写进同一张表,污染实验组与对照组的分离。
      if (opts.trustStorage !== undefined && cell.condition.arm.roleTrust) {
        await applyTrustObservations(
          opts.trustStorage,
          rewardObservations(result.snapshot, result.record.quality),
          alpha,
        );
      }

      lastTokens = result.record.committedTokens;
      lastElapsedMs = result.record.latencyMs;
      records.push(result.record);
      done += 1;
      opts.onProgress?.(done, opts.cells.length, result.record);
    } catch (error) {
      failed.push({
        cellKey: key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    attempted: opts.cells.length - skipped,
    succeeded: records.length,
    skipped,
    failed,
    records,
  };
}

/** transcript 的持久化形式(canonical 顺序由 JSON.stringify 的插入序保证)。 */
export function serializeTranscript(transcript: Transcript): string {
  return JSON.stringify({
    schemaVersion: 1,
    entries: transcript.entries.map((entry) => ({
      requestKey: entry.requestKey,
      request: entry.request,
      response: entry.response,
    })),
  });
}

/** 从持久化形式恢复 transcript。 */
export function deserializeTranscript(json: string): Transcript {
  const parsed = JSON.parse(json) as {
    schemaVersion?: number;
    entries?: { requestKey: string; request: unknown; response: unknown }[];
  };
  if (parsed.schemaVersion !== 1) {
    throw new SyntaxError("unsupported transcript schemaVersion");
  }
  const entries = parsed.entries ?? [];
  return Object.freeze({
    entries: Object.freeze(
      entries.map((e) =>
        Object.freeze({
          requestKey: e.requestKey,
          request: e.request as never,
          response: e.response as never,
        }),
      ),
    ),
  });
}

/** 由存盘的 transcript 构造离线重放工厂,使分析可零成本重跑。 */
export function replayFactoryFrom(transcript: Transcript): ModelFactory {
  const shared = new ReplayModel(transcript);
  return () => shared;
}

/** 读取已有 JSONL,得到已完成格子键(幂等重入)。 */
export async function loadCompletedKeys(
  sink: RunSink,
  recordsPath = DEFAULT_RECORDS_PATH,
): Promise<Set<string>> {
  if (!(await sink.exists(recordsPath))) {
    return new Set();
  }
  const text = await sink.read(recordsPath);
  const keys = new Set<string>();
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    const record = JSON.parse(line) as RunRecord;
    keys.add(`${record.model}::${record.conditionKey}::${record.taskId}::${record.seed}`);
  }
  return keys;
}

/** 成本估算:供 §5 的成本表与跑前预算核对。 */
export function estimateCost(
  cells: readonly Cell[],
  tokensPerRun: number,
): { cells: number; totalTokens: number; byModel: Record<string, number> } {
  const byModel: Record<string, number> = {};
  for (const cell of cells) {
    byModel[cell.model.name] = (byModel[cell.model.name] ?? 0) + tokensPerRun;
  }
  return {
    cells: cells.length,
    totalTokens: cells.length * tokensPerRun,
    byModel,
  };
}
