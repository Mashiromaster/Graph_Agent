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
 * 更要紧的约束是配额:实测连打约 40 格后开始返回 **HTTP 429**,而 A4/A5 恰好排在
 * 其后,整臂 9/9 与 5/8 作废。那种失败与拓扑无关,却会被读成"更复杂的臂更不
 * 可靠"。两处应对:格间 20s 节流(见 pacingMs),以及把重试退避总量提到 135s
 * 以跨过一个典型配额窗口(见 retrying-transport 的默认值)。
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
    // 节流:以 token 配额为准,20s 为下限。
    //
    // 实测 429 的真实原因是 `tokens limit for minute`(按 token 的滑动窗口),
    // 而非请求频率——故固定间隔治不了:mid 档单格抽 8105 tok/min,而探测显示
    // 约 4458 tok/min 才可持续。按上一格实际用量自适应,重格多等、轻格少等,
    // frontier 档自动获得更长间隔。
    pacingMs: 20000,
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
