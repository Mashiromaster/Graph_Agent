import { describe, expect, it } from "vitest";
import { InMemoryStorage } from "@graph-agent/session";
import {
  ScriptedModel,
  createModelResponse,
  createToolCall,
} from "@graph-agent/adapter";
import { createUsage } from "@graph-agent/core";
import { SPAWN_TOOL } from "@graph-agent/node";
import { loadTrustTable, trustForRole } from "@graph-agent/orchestrator";
import { ARMS, DEFAULT_TOGGLES } from "../src/arms.js";
import { createTask } from "../src/task.js";
import { mathScorer } from "../src/scorers/math.js";
import type { ModelFactory } from "../src/harness.js";
import {
  MissingCredential,
  faultyModelFactory,
  liveModelFactory,
  withSeedMetadata,
  type ModelSpec,
} from "../src/models.js";
import {
  cellKey,
  deserializeTranscript,
  estimateCost,
  loadCompletedKeys,
  plannedCells,
  replayFactoryFrom,
  runGrid,
  serializeTranscript,
  type Cell,
  type RunSink,
} from "../src/runner.js";

const task = createTask({
  id: "sum-1",
  family: "math",
  prompt: "What is 17 plus 25?",
  scorer: mathScorer("42"),
});

const smallModel: ModelSpec = {
  name: "small",
  model: "m-small",
  baseUrl: "https://example.invalid/v1",
  apiKeyEnv: "TEST_KEY",
  temperature: 0.7,
  maxOutputTokens: 256,
  timeoutSeconds: 30,
  confirmatoryOnly: false,
};

const frontierModel: ModelSpec = { ...smallModel, name: "frontier", confirmatoryOnly: true };

function soloFactory(answer = "42"): ModelFactory {
  return () =>
    new ScriptedModel([
      createModelResponse({
        content: `Answer: ${answer}`,
        usage: createUsage({ inputTokens: 20, outputTokens: 10 }),
      }),
    ]);
}

/** root 派生 worker + reducer 的脚本(用于 roleTrust 臂)。 */
function spawningFactory(answer = "42"): ModelFactory {
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
                objective: "compute",
                instructions: "do it",
                tool_names: [],
                priority: 0.5,
                budget_share: 0.2,
              },
            }),
          ],
          usage: createUsage({ inputTokens: 30, outputTokens: 12 }),
        }),
        createModelResponse({
          content: `Answer: ${answer}`,
          usage: createUsage({ inputTokens: 20, outputTokens: 8 }),
        }),
      ]);
    }
    return new ScriptedModel([
      createModelResponse({
        content: `got ${answer}`,
        usage: createUsage({ inputTokens: 10, outputTokens: 5 }),
      }),
    ]);
  };
}

function memorySink(): RunSink & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async appendLine(path, line) {
      files.set(path, `${files.get(path) ?? ""}${line}\n`);
    },
    async atomicWrite(path, bytes) {
      files.set(path, bytes);
    },
    async read(path) {
      const value = files.get(path);
      if (value === undefined) throw new Error(`no such file: ${path}`);
      return value;
    },
    async exists(path) {
      return files.has(path);
    },
  };
}

function clock(): () => number {
  let t = 0;
  return () => (t += 10);
}

const arm = (id: string) => ARMS.find((a) => a.id === id)!;

// ── 矩阵枚举与分层 ───────────────────────────────────────────────────────────

describe("plannedCells", () => {
  it("gives full-grid models every condition", () => {
    const cells = plannedCells({ models: [smallModel], tasks: [task], seeds: [0] });
    // 5 臂 + 2 个开关消融 = 7 配置。
    expect(cells).toHaveLength(7);
  });

  it("restricts a confirmatory-only model to A1/A3/A5 with both toggles on", () => {
    const cells = plannedCells({ models: [frontierModel], tasks: [task], seeds: [0] });
    expect(cells).toHaveLength(3);
    expect(cells.map((c) => c.condition.arm.id).sort()).toEqual(["A1", "A3", "A5"]);
    expect(cells.every((c) => c.condition.toggles.fanIn && c.condition.toggles.delivery)).toBe(
      true,
    );
  });

  it("uses a smaller seed set for the confirmatory tier when provided", () => {
    const cells = plannedCells({
      models: [frontierModel],
      tasks: [task],
      seeds: [0, 1, 2, 3, 4],
      confirmatorySeeds: [0, 1, 2],
    });
    expect(cells).toHaveLength(3 * 3);
  });

  it("multiplies tasks and seeds", () => {
    const second = createTask({
      id: "sum-2",
      family: "math",
      prompt: "What is 20 plus 22?",
      scorer: mathScorer("42"),
    });
    const cells = plannedCells({
      models: [smallModel],
      tasks: [task, second],
      seeds: [0, 1],
    });
    expect(cells).toHaveLength(7 * 2 * 2);
  });
});

describe("cellKey", () => {
  it("is unique per model/condition/task/seed", () => {
    const base: Cell = {
      model: smallModel,
      condition: { arm: arm("A1"), toggles: DEFAULT_TOGGLES },
      task,
      seed: 0,
    };
    expect(cellKey(base)).toBe("small::A1+fanin+deliv::sum-1::0");
    expect(cellKey({ ...base, seed: 1 })).not.toBe(cellKey(base));
    expect(cellKey({ ...base, model: frontierModel })).not.toBe(cellKey(base));
  });
});

describe("estimateCost", () => {
  it("reports cells, total tokens, and a per-model breakdown", () => {
    const cells = plannedCells({
      models: [smallModel, frontierModel],
      tasks: [task],
      seeds: [0],
    });
    const cost = estimateCost(cells, 15000);
    expect(cost.cells).toBe(10); // 7 + 3
    expect(cost.totalTokens).toBe(150000);
    expect(cost.byModel["small"]).toBe(7 * 15000);
    expect(cost.byModel["frontier"]).toBe(3 * 15000);
  });
});

// ── 运行与落盘 ───────────────────────────────────────────────────────────────

describe("runGrid", () => {
  it("writes one JSONL line and one transcript per cell", async () => {
    const sink = memorySink();
    const cells = plannedCells({ models: [smallModel], tasks: [task], seeds: [0] }).filter(
      (c) => c.condition.arm.id === "A1",
    );
    const summary = await runGrid({
      cells,
      factoryFor: () => soloFactory(),
      sink,
      wallClock: clock(),
    });

    expect(summary.succeeded).toBe(cells.length);
    expect(summary.failed).toEqual([]);
    const jsonl = sink.files.get("records.jsonl")!;
    expect(jsonl.trim().split("\n")).toHaveLength(cells.length);
    for (const cell of cells) {
      expect(sink.files.has(`transcripts/${cellKey(cell)}.json`)).toBe(true);
    }
  });

  it("skips cells already present in the records file (idempotent re-entry)", async () => {
    const sink = memorySink();
    const cells = plannedCells({ models: [smallModel], tasks: [task], seeds: [0] }).filter(
      (c) => c.condition.arm.id === "A1",
    );
    await runGrid({ cells, factoryFor: () => soloFactory(), sink, wallClock: clock() });

    const completed = await loadCompletedKeys(sink);
    expect(completed.size).toBe(cells.length);

    const second = await runGrid({
      cells,
      factoryFor: () => soloFactory(),
      sink,
      completedKeys: completed,
      wallClock: clock(),
    });
    expect(second.skipped).toBe(cells.length);
    expect(second.succeeded).toBe(0);
    // JSONL 没有被追加重复行。
    expect(sink.files.get("records.jsonl")!.trim().split("\n")).toHaveLength(
      cells.length,
    );
  });

  it("records a failing cell without aborting the rest", async () => {
    const sink = memorySink();
    const cells = plannedCells({ models: [smallModel], tasks: [task], seeds: [0, 1] }).filter(
      (c) => c.condition.arm.id === "A1",
    );
    let calls = 0;
    const summary = await runGrid({
      cells,
      factoryFor: () => () => {
        calls += 1;
        if (calls === 1) {
          throw new Error("simulated rate limit");
        }
        return soloFactory()({ nodeId: "root", role: "orchestrator", seed: 0 });
      },
      sink,
      wallClock: clock(),
    });
    expect(summary.failed).toHaveLength(1);
    expect(summary.failed[0]!.error).toContain("simulated rate limit");
    expect(summary.succeeded).toBe(1);
  });

  it("reports progress for each completed cell", async () => {
    const sink = memorySink();
    const cells = plannedCells({ models: [smallModel], tasks: [task], seeds: [0] }).filter(
      (c) => c.condition.arm.id === "A1",
    );
    const seen: number[] = [];
    await runGrid({
      cells,
      factoryFor: () => soloFactory(),
      sink,
      wallClock: clock(),
      onProgress: (done) => seen.push(done),
    });
    expect(seen).toEqual([1]);
  });
});

describe("cross-run trust learning in the grid", () => {
  it("accumulates trust only for arms that enable role trust", async () => {
    const sink = memorySink();
    const storage = new InMemoryStorage();
    // A5 启用 roleTrust;跑两次同一格(不同 seed)应累积观测。
    const cells = plannedCells({
      models: [smallModel],
      tasks: [task],
      seeds: [0, 1],
    }).filter((c) => c.condition.arm.id === "A5" && c.condition.toggles.delivery);

    await runGrid({
      cells,
      factoryFor: () => spawningFactory(),
      sink,
      trustStorage: storage,
      trustAlpha: 0.5,
      wallClock: clock(),
    });

    const table = await loadTrustTable(storage);
    // orchestrator 与 worker 都被观测过,且因全对而维持高位。
    expect(trustForRole(table, "orchestrator")).toBeGreaterThan(0.5);
    expect(table.size).toBeGreaterThan(0);
  });

  it("leaves the trust table untouched for control arms", async () => {
    const sink = memorySink();
    const storage = new InMemoryStorage();
    const cells = plannedCells({ models: [smallModel], tasks: [task], seeds: [0] }).filter(
      (c) => c.condition.arm.id === "A1",
    );
    await runGrid({
      cells,
      factoryFor: () => soloFactory(),
      sink,
      trustStorage: storage,
      wallClock: clock(),
    });
    // A1 的 roleTrust 为 false → 不写表,避免对照臂的观测污染实验臂。
    expect((await loadTrustTable(storage)).size).toBe(0);
  });
});

// ── transcript 往返与离线重放 ────────────────────────────────────────────────

describe("transcript persistence", () => {
  it("round-trips through serialize/deserialize", async () => {
    const sink = memorySink();
    const cells = plannedCells({ models: [smallModel], tasks: [task], seeds: [0] }).filter(
      (c) => c.condition.arm.id === "A1",
    );
    await runGrid({ cells, factoryFor: () => soloFactory(), sink, wallClock: clock() });
    const json = sink.files.get(`transcripts/${cellKey(cells[0]!)}.json`)!;
    const transcript = deserializeTranscript(json);
    expect(transcript.entries.length).toBeGreaterThan(0);
    expect(serializeTranscript(transcript)).toBe(json);
  });

  it("rejects an unknown schema version", () => {
    expect(() => deserializeTranscript('{"schemaVersion":99,"entries":[]}')).toThrow(
      "unsupported transcript schemaVersion",
    );
  });

  it("replays a stored transcript to the same digest at zero API cost", async () => {
    // 这是补充材料的核心承诺:审稿人用存盘 transcript 即可复算每个数字。
    const sink = memorySink();
    const cells = plannedCells({ models: [smallModel], tasks: [task], seeds: [0] }).filter(
      (c) => c.condition.arm.id === "A1",
    );
    const live = await runGrid({
      cells,
      factoryFor: () => soloFactory(),
      sink,
      wallClock: clock(),
    });

    const stored = deserializeTranscript(
      sink.files.get(`transcripts/${cellKey(cells[0]!)}.json`)!,
    );
    const replaySink = memorySink();
    const replayed = await runGrid({
      cells,
      factoryFor: () => replayFactoryFrom(stored),
      sink: replaySink,
      wallClock: clock(),
    });

    expect(replayed.succeeded).toBe(1);
    expect(replayed.records[0]!.digest).toBe(live.records[0]!.digest);
    expect(replayed.records[0]!.quality).toBe(live.records[0]!.quality);
  });
});

// ── 模型接线 ─────────────────────────────────────────────────────────────────

describe("liveModelFactory", () => {
  it("throws a named error when the credential is absent", () => {
    expect(() => liveModelFactory(smallModel, {})).toThrow(MissingCredential);
    expect(() => liveModelFactory(smallModel, { TEST_KEY: "  " })).toThrow("TEST_KEY");
  });

  it("builds a factory when the credential is present", () => {
    const factory = liveModelFactory(smallModel, { TEST_KEY: "sk-test" });
    expect(typeof factory({ nodeId: "root", role: "orchestrator", seed: 0 }).complete).toBe(
      "function",
    );
  });
});

describe("withSeedMetadata", () => {
  it("tags the request so different seeds get different replay keys", async () => {
    const captured: unknown[] = [];
    const inner = {
      async complete(request: never) {
        captured.push(request);
        return createModelResponse({ content: "ok" });
      },
    };
    await withSeedMetadata(inner as never, 3).complete({
      nodeId: "n",
      instructions: "i",
      messages: [],
      tools: [],
      metadata: {},
    } as never);
    expect((captured[0] as { metadata: Record<string, unknown> }).metadata["__seed"]).toBe(3);
  });
});

describe("faultyModelFactory", () => {
  it("replaces only the targeted role with a confident wrong answer", async () => {
    const factory = faultyModelFactory(soloFactory("42"), {
      role: "suspect",
      wrongAnswer: "99",
    });
    const good = await factory({ nodeId: "n1", role: "worker", seed: 0 }).complete({
      nodeId: "n1",
      instructions: "i",
      messages: [],
      tools: [],
      metadata: {},
    } as never);
    expect(good.content).toContain("42");

    const bad = await factory({ nodeId: "n2", role: "suspect", seed: 0 }).complete({
      nodeId: "n2",
      instructions: "i",
      messages: [],
      tools: [],
      metadata: {},
    } as never);
    expect(bad.content).toContain("99");
    // 「自信」是刻意的:真实世界里最难被下游察觉的失效模式。
    expect(bad.content).toContain("verified this carefully");
  });
});
