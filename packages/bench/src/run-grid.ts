/**
 * 正式网格执行脚本。
 *
 * ## 规模由实测决定,不是取整数
 *
 * 先导数据给出配对质量差的 sd ≈ 0.15,按 alpha=.05 / power=.80 反解,15 个配对
 * 可检出 delta ≈ 0.11。3 题 × 5 种子正好给到 15 配对/配置。
 *
 * ## 真正的瓶颈是墙钟时间与配额,不是 token 总量
 *
 * 该端点**不支持并发**(6 个并发请求挂死超过 3 分钟),故 runner 串行。实测单格
 * 耗时分两档:不派生 96s、派生 313s。3 题 × 3 种子 = 153 格(27 solo + 126
 * spawning)≈ 11.7 小时 ≈ 320 万 token。
 *
 * 更要紧的约束是配额:429 的实际语义是 `tokens limit for minute`,一个**滑动
 * 分钟窗口**。实测连打约 40 格后开始触发,而失败总是落在排序靠后的臂上,于是
 * 整臂作废——那种失败与拓扑无关,却会被读成"更复杂的臂更不可靠"。
 * 应对见 runGrid 调用处的 pacingMs 注释(90s 下限 + 按 token 自适应)。
 *
 * ## 中断安全
 *
 * 逐格 append JSONL,`loadCompletedKeys` 支持幂等重入。十余小时的运行几乎必然
 * 遇到限流或网络抖动,重入能力不是奢侈品。注意:重入只跳过**成功**格——被
 * 限流污染的失败格应先从 JSONL 删除,否则会被当成已完成而永不重跑。
 */

import { FileStorage } from "@graph-agent/session";
import {
  estimateCost,
  loadCompletedKeys,
  plannedCells,
  runGrid,
  type RunSink,
} from "./runner.js";
import { liveModelFactory } from "./models.js";
import { liveModelMatrix } from "./live.js";
import { decomposableTasks } from "./tasks/decomposable.js";
import type { ModelSpec } from "./models.js";

/** 由 FileStorage 适配出 RunSink(只需四个方法)。 */
function fileSink(rootDir: string): RunSink {
  const storage = new FileStorage({ rootDir });
  return {
    appendLine: (path, line) => storage.appendLine(path, line),
    atomicWrite: (path, bytes) => storage.atomicWrite(path, bytes),
    read: (path) => storage.read(path),
    exists: (path) => storage.exists(path),
  };
}

export interface GridOptions {
  readonly rootDir?: string;
  readonly seeds?: readonly number[];
  readonly confirmatorySeeds?: readonly number[];
  /** 只跑这些模型档位(按 name 过滤);省略则全跑。 */
  readonly onlyModels?: readonly string[];
  readonly dryRun?: boolean;
}

export async function main(opts: GridOptions = {}): Promise<void> {
  const rootDir = opts.rootDir ?? "results";
  const seeds = opts.seeds ?? [0, 1, 2, 3, 4];
  const confirmatorySeeds = opts.confirmatorySeeds ?? seeds;

  let models: ModelSpec[] = liveModelMatrix();
  if (opts.onlyModels !== undefined) {
    const wanted = new Set(opts.onlyModels);
    models = models.filter((m) => wanted.has(m.name));
  }

  const tasks = decomposableTasks();
  const cells = plannedCells({ models, tasks, seeds, confirmatorySeeds });

  // 成本与时长预估:跑前报告,不让规模靠行数事后推断。
  const cost = estimateCost(cells, 21000);
  // 按格类型分别估时,而非用一个平均 calls/cell。
  //
  // 实测:不派生格(A1)均值 96s,派生格均值 313s——相差 3.3 倍。用单一均值会
  // 把总时长低报到 1/4(首次 dry-run 报 3.1h,实际投影 11.7h)。低报的危害不只是
  // 不准:它会让人按错误的时间预算决定种子数,而种子数直接决定统计功效。
  const spawnCells = cells.filter((c) => c.condition.arm.spawn).length;
  const soloCells = cells.length - spawnCells;
  const SOLO_SECONDS = 96;
  const SPAWN_SECONDS = 313;
  const hours = (soloCells * SOLO_SECONDS + spawnCells * SPAWN_SECONDS) / 3600;
  console.log("=== grid plan ===");
  console.log(`models : ${models.map((m) => `${m.name}(${m.model})`).join(", ")}`);
  console.log(`tasks  : ${tasks.map((t) => t.id).join(", ")}`);
  console.log(`seeds  : [${seeds.join(",")}] (confirmatory [${confirmatorySeeds.join(",")}])`);
  console.log(`cells  : ${cells.length} (${soloCells} solo, ${spawnCells} spawning)`);
  console.log(`tokens : ~${(cost.totalTokens / 1e6).toFixed(2)}M`);
  console.log(
    `wall   : ~${hours.toFixed(1)} h serial ` +
      `(solo ${SOLO_SECONDS}s, spawning ${SPAWN_SECONDS}s; endpoint rejects concurrency)`,
  );
  for (const [name, tok] of Object.entries(cost.byModel)) {
    console.log(`  ${name}: ~${(tok / 1e6).toFixed(2)}M tokens`);
  }
  if (opts.dryRun === true) {
    console.log("(dry run, nothing executed)");
    return;
  }

  const sink = fileSink(rootDir);
  const completed = await loadCompletedKeys(sink);
  if (completed.size > 0) {
    console.log(`resuming: ${completed.size} cells already recorded`);
  }

  const started = Date.now();
  const summary = await runGrid({
    cells,
    factoryFor: (model) => liveModelFactory(model),
    sink,
    completedKeys: completed,
    // 90s 固定下限 + 按 token 自适应,取较大者。
    //
    // 为什么下限要大于配额窗口:429 是**滑动分钟窗口**。实测 mid 档单格在
    // 其 246s 运行期内以 5783 tok/min 的速率抽取,这个瞬时速率由模型生成速度
    // 决定,**事后等待无法降低它**。自适应公式在稳态上算得没错(23679 tok /
    // 355s 恰为 4000 tok/min),但它用已花墙钟去抵扣等待,于是格与格之间的
    // 间隔可能短于 60s——上一格的用量还没从滑动窗口里退出,下一格就开始叠加。
    //
    // 修法不是把目标速率压到 2000(那样单格周期 710s,126 格要 24.8h),而是
    // 给一个**超过窗口长度**的绝对下限:90s 保证上一格的配额完全退出窗口,
    // 代价是 126 × 90s ≈ 3.1h,而非 15h。
    pacingMs: 90000,
    tokensPerMinute: 4000,
    // trust 表跨运行累积,仅在启用 roleTrust 的臂(A5)上更新。
    trustStorage: new FileStorage({ rootDir }),
    trustAlpha: 0.2,
    onProgress: (done, total, record) => {
      const elapsed = (Date.now() - started) / 1000;
      const rate = done / elapsed;
      const etaMin = rate > 0 ? (total - done) / rate / 60 : 0;
      console.log(
        `[${done}/${total}] ${record.conditionKey} ${record.taskId} s${record.seed} ` +
          `${record.model} q=${record.quality.toFixed(2)} n=${record.nodeCount} ` +
          `tok=${record.committedTokens} | eta ${etaMin.toFixed(0)}min`,
      );
    },
  });

  console.log("\n=== summary ===");
  console.log(`attempted ${summary.attempted}, succeeded ${summary.succeeded}, skipped ${summary.skipped}`);
  if (summary.failed.length > 0) {
    console.log(`failed ${summary.failed.length}:`);
    for (const f of summary.failed.slice(0, 20)) {
      console.log(`  ${f.cellKey}: ${f.error}`);
    }
  }
}
