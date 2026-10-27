/**
 * 正式网格执行脚本。
 *
 * ## 规模由实测决定,不是取整数
 *
 * 先导数据给出配对质量差的 sd ≈ 0.15,按 alpha=.05 / power=.80 反解,15 个配对
 * 可检出 delta ≈ 0.11。3 题 × 5 种子正好给到 15 配对/配置。
 *
 * ## 真正的瓶颈是墙钟时间
 *
 * 实测该端点单次调用约 21s,且**不支持并发**——6 个并发请求直接挂死超过 3 分钟。
 * 因此 runner 必须串行,总时长 = 调用数 × 21s:
 *
 *   small  7 配置 × 15 = 105 格
 *   mid    7 配置 × 15 = 105 格
 *   front  3 配置 × 15 =  45 格(确认子集 A1/A3/A5)
 *   合计 255 格 ≈ 1095 次模型调用 ≈ 6.4 小时 ≈ 530 万 token
 *
 * token 不是约束(5.3M 远低于配额压力),墙钟才是。这也是为什么不选 8 种子:
 * 功效从 0.11 提到 0.086,代价是 10.2 小时。
 *
 * ## 中断安全
 *
 * 逐格 append JSONL,`loadCompletedKeys` 支持幂等重入。6 小时的运行几乎必然
 * 遇到至少一次网络抖动或限流,重入能力不是奢侈品。
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
  const callsPerCell = 3.5; // 实测均值:单节点 1 次,派生臂约 5 次
  const hours = (cells.length * callsPerCell * 21) / 3600;
  console.log("=== grid plan ===");
  console.log(`models : ${models.map((m) => `${m.name}(${m.model})`).join(", ")}`);
  console.log(`tasks  : ${tasks.map((t) => t.id).join(", ")}`);
  console.log(`seeds  : [${seeds.join(",")}] (confirmatory [${confirmatorySeeds.join(",")}])`);
  console.log(`cells  : ${cells.length}`);
  console.log(`tokens : ~${(cost.totalTokens / 1e6).toFixed(2)}M`);
  console.log(`wall   : ~${hours.toFixed(1)} h serial (endpoint rejects concurrency)`);
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
