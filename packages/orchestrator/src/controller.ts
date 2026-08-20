/**
 * GraphController:编排层门面。
 *
 * 控制器是编排层的唯一有状态入口——它拥有每个运行的 MutableRunState 与事件链,
 * 并把 Task 1-8 的确定性构件(scheduler / mutations / budget / snapshot)编排成
 * 一个可运行、可 checkpoint、可 replay 的超级步循环。
 *
 * ## 并发纪律(mutex discipline)
 *
 * 两把锁,均为纯内存 promise-chain 互斥量(无外部依赖):
 * - **全局锁** `globalMutex`:序列化所有对任一运行 MutableRunState 的读写,保证
 *   单写者语义(记录本身不可变,替换而非原地改)。
 * - **每运行锁** `runMutex.get(runId)`:让 `runSuperstep`/`addDependency`/`cancel`
 *   对同一运行单飞(single-flight),防止并发超级步交叠。
 *
 * 关键:**执行阶段绝不持有全局锁**。runSuperstep 在临界区内冻结前沿并领取执行
 * (持全局锁),随后**释放全局锁**再并发驱动 runner(纯 IO,可长时间阻塞),
 * 最后**重新获取全局锁**做确定性归并。同一调用路径绝不重入同一把锁——每个公开
 * 方法在边界处只获取一次每运行锁,内部对全局锁的获取/释放严格配对且不嵌套。
 *
 * ## 归并确定性(sequence-based merge)
 *
 * 这是确定性的核心:并发执行返回的原始结果**按 execution.sequence 排序**后再归并,
 * 而非按完成顺序。因此无论 runner 以何种顺序/时延完成,ingestLocked/settleException
 * 的调用顺序恒定,最终快照(节点/边/决策序 + 预算)逐字节一致。
 *
 * ## replay 纯度
 *
 * `replay`/`replayCheckpoint` 是静态、纯函数:只消费事件链里的快照,经
 * validateSnapshot 再校验后返回,**绝不触碰 factory/runner**。
 *
 * 确定性:无 Date.now()/Math.random()。控制器事件无时间戳,故实际不需要时钟;
 * 为 API 完整性仍接受可选 `clock` 参数(当前未被内部逻辑使用)。
 */

import { canonicalJson, sha256, type AgentInput } from "@graph-agent/core";
import type { ControllerPolicy } from "./policy.js";
import { deriveControllerId } from "./ids.js";
import {
  EdgeType,
  NodeState,
  RunStatus,
  createEdgeRecord,
  createNodeRecord,
  runSnapshotFromDict,
  runSnapshotToDict,
  type RunSnapshot,
} from "./graph-models.js";
import {
  createMutableRunState,
  snapshotOf,
  type MutableRunState,
} from "./mutable-state.js";
import { validateSnapshot } from "./snapshot-validation.js";
import {
  CONTROLLER_GENESIS_HASH,
  appendControllerEvent,
  assertNoDuplicateKeys,
  controllerEventDetail,
  createControllerEvent,
  verifyControllerEventChain,
  type ControllerEvent,
  type ControllerEventType,
} from "./controller-events.js";
import type { AgentSpec, NodeFactory, NodeRunner } from "./runner.js";
import {
  blockFailedDependents,
  cancelClaims,
  freezeFrontierAndClaim,
  ingestLocked,
  settleException,
  settleRun,
  type Claim,
} from "./scheduler.js";

const CONTROLLER_EVENT_TYPES: readonly ControllerEventType[] = [
  "run_created",
  "snapshot",
  "dependency_added",
  "execution_settled",
];

const MAX_CHECKPOINT_BYTES = 5_000_000;
const CHECKPOINT_SCHEMA_VERSION = 1;
const CHECKPOINT_KEYS = [
  "chainHead",
  "eventCount",
  "events",
  "runId",
  "schemaVersion",
  "stateDigest",
];

/** 每个运行的私有存储:唯一可变态 + 追加式事件链。 */
interface RunEntry {
  state: MutableRunState;
  events: ControllerEvent[];
}

/**
 * 最小化异步互斥量:promise-chain 队列。`acquire` 返回一个 release 回调;调用它
 * 才放行下一个等待者。与 session 的 withLock 同构,但无外部依赖。
 */
class Mutex {
  private tail: Promise<void> = Promise.resolve();

  async acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.tail;
    this.tail = this.tail.then(() => next);
    await previous;
    return release;
  }
}

/**
 * 以 max 并发上限运行一批异步任务,返回与输入等长、同序的结果数组。
 * 用 promise 池:任一时刻至多 max 个在飞。不抛错——每个任务自身用 try/catch 包裹
 * (调用方负责),这里只做并发调度。
 */
async function runBounded<T>(
  count: number,
  max: number,
  task: (index: number) => Promise<T>,
): Promise<T[]> {
  const results = new Array<T>(count);
  let next = 0;
  const limit = Math.max(1, max);
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= count) {
        return;
      }
      results[index] = await task(index);
    }
  };
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(limit, count); i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

/** 一个已完成执行的原始产物:成功结果或抛出的错误(尚未归并)。 */
interface RawOutcome {
  claim: Claim;
  ok: boolean;
  result: unknown; // AgentResult when ok, else the thrown value
}

export class GraphController {
  private readonly factory: NodeFactory;
  private readonly policy: ControllerPolicy;
  // 保留时钟以备 API 完整性(控制器事件无时间戳,故当前未使用)。
  private readonly clock: () => number;
  private readonly runs = new Map<string, RunEntry>();
  private readonly globalMutex = new Mutex();
  private readonly runMutex = new Map<string, Mutex>();

  constructor(factory: NodeFactory, policy: ControllerPolicy, clock: () => number = () => 0) {
    this.factory = factory;
    this.policy = policy;
    this.clock = clock;
  }

  private mutexFor(runId: string): Mutex {
    let mutex = this.runMutex.get(runId);
    if (mutex === undefined) {
      mutex = new Mutex();
      this.runMutex.set(runId, mutex);
    }
    return mutex;
  }

  private require(runId: string): RunEntry {
    const entry = this.runs.get(runId);
    if (entry === undefined) {
      throw new Error(`unknown run: ${runId}`);
    }
    return entry;
  }

  /** 追加事件到某运行的事件链(调用方须持全局锁)。 */
  private appendEventFor(entry: RunEntry): (type: ControllerEventType, detail: object) => void {
    return (type, detail) => {
      entry.events = appendControllerEvent(entry.events, entry.state.runId, type, detail);
    };
  }

  /** 追加一条 snapshot 事件,载荷为当前状态的冻结快照字典(调用方须持全局锁)。 */
  private appendSnapshot(entry: RunEntry): void {
    this.appendEventFor(entry)("snapshot", {
      snapshot: runSnapshotToDict(snapshotOf(entry.state)),
    });
  }

  // ── createRun ──────────────────────────────────────────────────────────────

  async createRun(
    runId: string,
    rootSpec: AgentSpec,
    rootRunner: NodeRunner,
    rootInput: AgentInput,
  ): Promise<RunSnapshot> {
    const release = await this.globalMutex.acquire();
    try {
      if (this.runs.has(runId)) {
        throw new Error(`run already exists: ${runId}`);
      }
      const state = createMutableRunState(runId, this.policy);
      const entry: RunEntry = { state, events: [] };

      const nodeId = rootSpec.identity.nodeId;
      const generation = rootSpec.identity.generation ?? 0;
      const allocation = Math.min(rootSpec.budget.maxTotalTokens, this.policy.maxTotalTokens);
      const allowedToolNames = (rootSpec as { toolNames?: readonly string[] }).toolNames ?? [];

      const root = createNodeRecord({
        nodeId,
        name: rootSpec.identity.name,
        role: rootSpec.role ?? rootSpec.identity.role,
        parentNodeId: null,
        generation,
        priority: 0.5,
        state: NodeState.READY,
        allowedToolNames,
        allocationTokens: allocation,
      });

      state.nodes.set(nodeId, root);
      state.specs.set(nodeId, rootSpec);
      state.runners.set(nodeId, rootRunner);
      state.inputs.set(nodeId, rootInput);
      state.nodeReservations.set(nodeId, allocation);
      state.reservedTokens += allocation;

      this.runs.set(runId, entry);
      const append = this.appendEventFor(entry);
      append("run_created", {});
      this.appendSnapshot(entry);

      return snapshotOf(state);
    } finally {
      release();
    }
  }

  // ── runSuperstep ─────────────────────────────────────────────────────────────

  async runSuperstep(runId: string): Promise<RunSnapshot> {
    const runRelease = await this.mutexFor(runId).acquire();
    try {
      return await this.runSuperstepInner(runId);
    } finally {
      runRelease();
    }
  }

  /** 单个超级步的三段式实现;调用方已持有每运行锁。 */
  private async runSuperstepInner(runId: string): Promise<RunSnapshot> {
    // ── 段 1:临界区(持全局锁)——冻结前沿并领取 ──────────────────────────────
    let claims: Claim[];
    {
      const release = await this.globalMutex.acquire();
      try {
        const entry = this.require(runId);
        if (entry.state.status !== RunStatus.RUNNING) {
          return snapshotOf(entry.state);
        }
        claims = freezeFrontierAndClaim(entry.state);
        if (claims.length === 0) {
          // 无可运行:收敛并收尾。
          blockFailedDependents(entry.state);
          settleRun(entry.state);
          this.appendSnapshot(entry);
          return snapshotOf(entry.state);
        }
      } finally {
        release();
      }
    }

    // ── 段 2:执行阶段(不持任何全局锁)——并发驱动 runner ────────────────────────
    const controller = new AbortController();
    const outcomes = await runBounded<RawOutcome>(
      claims.length,
      this.policy.maxConcurrency,
      async (index) => {
        const claim = claims[index]!;
        try {
          const runner = claim.runner as NodeRunner;
          const result = await runner.run(claim.input, controller.signal);
          return { claim, ok: true, result };
        } catch (error) {
          // 节点自取消(RunnerCancelledError)与任意其它抛错一律作为异常结果捕获。
          return { claim, ok: false, result: error };
        }
      },
    );

    // ── 段 3:临界区(重新持全局锁)——按 sequence 确定性归并 ──────────────────────
    {
      const release = await this.globalMutex.acquire();
      try {
        const entry = this.require(runId);
        const append = this.appendEventFor(entry);

        // 确定性核心:按 execution.sequence 排序,而非完成顺序。
        const ordered = [...outcomes].sort(
          (a, b) => a.claim.execution.sequence - b.claim.execution.sequence,
        );
        for (const outcome of ordered) {
          const { claim } = outcome;
          if (outcome.ok) {
            ingestLocked(
              entry.state,
              claim.execution,
              claim.node,
              outcome.result as never,
              append,
              this.factory,
            );
          } else {
            settleException(entry.state, claim.execution, claim.node, outcome.result, append);
          }
        }

        blockFailedDependents(entry.state);
        settleRun(entry.state);
        this.appendSnapshot(entry);
        return snapshotOf(entry.state);
      } finally {
        release();
      }
    }
  }

  // ── runUntilIdle ─────────────────────────────────────────────────────────────

  async runUntilIdle(runId: string): Promise<RunSnapshot> {
    const cap = this.policy.maxNodes + this.policy.maxTotalTokens;
    let snapshot: RunSnapshot | undefined;
    for (let iteration = 0; iteration <= cap; iteration += 1) {
      snapshot = await this.runSuperstep(runId);
      if (snapshot.pendingExecutions === 0 || snapshot.status !== RunStatus.RUNNING) {
        return snapshot;
      }
    }
    throw new Error(`runUntilIdle exceeded ${cap} supersteps for run ${runId}`);
  }

  // ── addDependency ────────────────────────────────────────────────────────────

  async addDependency(
    runId: string,
    sourceNodeId: string,
    targetNodeId: string,
  ): Promise<RunSnapshot> {
    const runRelease = await this.mutexFor(runId).acquire();
    try {
      const release = await this.globalMutex.acquire();
      try {
        const entry = this.require(runId);
        const state = entry.state;
        const source = state.nodes.get(sourceNodeId);
        const target = state.nodes.get(targetNodeId);
        if (source === undefined) {
          throw new Error(`unknown source node: ${sourceNodeId}`);
        }
        if (target === undefined) {
          throw new Error(`unknown target node: ${targetNodeId}`);
        }
        if (target.state !== NodeState.READY) {
          throw new Error(`dependency target must be READY: ${targetNodeId}`);
        }
        // DAG 守护:若 target 已能经 spawn+depends_on 边到达 source,则新增
        // source→target 会成环 → 拒绝。
        if (this.reaches(state, targetNodeId, sourceNodeId)) {
          throw new Error(`dependency would create a cycle: ${sourceNodeId} -> ${targetNodeId}`);
        }

        state.edges.push(
          createEdgeRecord({
            edgeId: deriveControllerId("dependency", runId, sourceNodeId, targetNodeId),
            sourceNodeId,
            targetNodeId,
            type: EdgeType.DEPENDS_ON,
          }),
        );
        const append = this.appendEventFor(entry);
        append("dependency_added", { sourceNodeId, targetNodeId });
        this.appendSnapshot(entry);
        return snapshotOf(state);
      } finally {
        release();
      }
    } finally {
      runRelease();
    }
  }

  /**
   * 沿 SPAWN + DEPENDS_ON 有向边做可达性判定:from 能否到达 to。用于成环检测。
   */
  private reaches(state: MutableRunState, from: string, to: string): boolean {
    if (from === to) {
      return true;
    }
    const adjacency = new Map<string, string[]>();
    for (const edge of state.edges) {
      if (edge.type === EdgeType.SPAWN || edge.type === EdgeType.DEPENDS_ON) {
        const list = adjacency.get(edge.sourceNodeId) ?? [];
        list.push(edge.targetNodeId);
        adjacency.set(edge.sourceNodeId, list);
      }
    }
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === to) {
        return true;
      }
      if (seen.has(current)) {
        continue;
      }
      seen.add(current);
      for (const nextNode of adjacency.get(current) ?? []) {
        stack.push(nextNode);
      }
    }
    return false;
  }

  // ── cancel ───────────────────────────────────────────────────────────────────

  async cancel(runId: string): Promise<RunSnapshot> {
    const runRelease = await this.mutexFor(runId).acquire();
    try {
      const release = await this.globalMutex.acquire();
      try {
        const entry = this.require(runId);
        // 超级步之间取消:无 in-flight claims,传 [] 让其取消 READY 节点并置 CANCELLED。
        cancelClaims(entry.state, []);
        this.appendSnapshot(entry);
        return snapshotOf(entry.state);
      } finally {
        release();
      }
    } finally {
      runRelease();
    }
  }

  // ── checkpoint ─────────────────────────────────────────────────────────────────

  async checkpoint(runId: string): Promise<string> {
    const release = await this.globalMutex.acquire();
    try {
      const entry = this.require(runId);
      const events = entry.events;
      const chainHead =
        events.length > 0 ? events[events.length - 1]!.eventHash : CONTROLLER_GENESIS_HASH;
      const stateDigest = sha256(
        canonicalJson(runSnapshotToDict(snapshotOf(entry.state))),
      );
      return canonicalJson({
        chainHead,
        eventCount: events.length,
        events: events.map((event) => ({ ...event })),
        runId,
        schemaVersion: CHECKPOINT_SCHEMA_VERSION,
        stateDigest,
      });
    } finally {
      release();
    }
  }

  // ── replay (static, pure) ────────────────────────────────────────────────────

  /**
   * 由事件链纯函数式重建最终快照。绝不调用 factory/runner:只解析事件链里的
   * snapshot 载荷,经 validateSnapshot 再校验。任一校验失败即抛错(fail-closed)。
   */
  static replay(events: readonly ControllerEvent[]): RunSnapshot {
    if (!verifyControllerEventChain(events)) {
      throw new Error("controller event chain verification failed");
    }
    if (events[0]!.type !== "run_created") {
      throw new Error("first controller event must be run_created");
    }
    for (const event of events) {
      if (!CONTROLLER_EVENT_TYPES.includes(event.type)) {
        throw new Error(`unknown controller event type: ${event.type}`);
      }
    }
    const runId = events[0]!.runId;
    const snapshots: RunSnapshot[] = [];
    for (const event of events) {
      if (event.type !== "snapshot") {
        continue;
      }
      const detail = controllerEventDetail(event) as { snapshot?: unknown };
      const snapshot = runSnapshotFromDict(detail.snapshot);
      const code = validateSnapshot(snapshot, runId);
      if (code !== null) {
        throw new Error(`replayed snapshot failed validation: ${code}`);
      }
      snapshots.push(snapshot);
    }
    if (snapshots.length === 0) {
      throw new Error("controller event chain contains no snapshot events");
    }
    return snapshots[snapshots.length - 1]!;
  }

  /**
   * 从 checkpoint JSON 串校验并重建最终快照。strict:长度上限、拒绝重复键、键集
   * 严格匹配、header 一致性、state digest 复算一致。绝不调用 factory/runner。
   */
  static replayCheckpoint(json: string): RunSnapshot {
    if (typeof json !== "string") {
      throw new TypeError("checkpoint must be a string");
    }
    if (json.length > MAX_CHECKPOINT_BYTES) {
      throw new RangeError("checkpoint exceeds maximum size");
    }
    // 全深度拒绝重复键(复用 controller-events 的词法扫描器):顶层键集的严格性
    // 由下方的 exact-6-key 检查保证,而 events 里任一对象嵌套的重复键也一并拒绝。
    assertNoDuplicateKeys(json);
    const parsed = JSON.parse(json) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new SyntaxError("checkpoint must be a JSON object");
    }
    const root = parsed as Record<string, unknown>;
    const keys = Object.keys(root).sort();
    if (keys.length !== CHECKPOINT_KEYS.length || !CHECKPOINT_KEYS.every((k, i) => keys[i] === k)) {
      throw new SyntaxError("checkpoint has an unexpected key set");
    }
    if (root["schemaVersion"] !== CHECKPOINT_SCHEMA_VERSION) {
      throw new SyntaxError("unsupported checkpoint schemaVersion");
    }
    if (!Array.isArray(root["events"])) {
      throw new SyntaxError("checkpoint events must be an array");
    }
    const rawEvents = root["events"] as unknown[];
    const events: ControllerEvent[] = rawEvents.map((raw) => rebuildEvent(raw));

    if (root["eventCount"] !== events.length) {
      throw new SyntaxError("checkpoint eventCount mismatch");
    }
    if (events.length === 0) {
      throw new SyntaxError("checkpoint has no events");
    }
    const expectedHead = events[events.length - 1]!.eventHash;
    if (root["chainHead"] !== expectedHead) {
      throw new SyntaxError("checkpoint chainHead mismatch");
    }
    if (root["runId"] !== events[0]!.runId) {
      throw new SyntaxError("checkpoint runId mismatch");
    }

    const snapshot = GraphController.replay(events);
    const digest = sha256(canonicalJson(runSnapshotToDict(snapshot)));
    if (root["stateDigest"] !== digest) {
      throw new Error("checkpoint state digest mismatch");
    }
    return snapshot;
  }
}

/**
 * 由 checkpoint 里的普通对象重建一条 ControllerEvent,并**复算 eventHash 校验**。
 * 复用 createControllerEvent 保证哈希口径一致:任何字段篡改都会导致复算的
 * eventHash 与存储值不符 → 抛错。
 */
function rebuildEvent(raw: unknown): ControllerEvent {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SyntaxError("checkpoint event must be an object");
  }
  const record = raw as Record<string, unknown>;
  const sequence = record["sequence"];
  const runId = record["runId"];
  const type = record["type"];
  const detailJson = record["detailJson"];
  const previousHash = record["previousHash"];
  const eventHash = record["eventHash"];
  const schemaVersion = record["schemaVersion"];
  if (
    typeof sequence !== "number" ||
    typeof runId !== "string" ||
    typeof type !== "string" ||
    typeof detailJson !== "string" ||
    typeof previousHash !== "string" ||
    typeof eventHash !== "string" ||
    schemaVersion !== CHECKPOINT_SCHEMA_VERSION
  ) {
    throw new SyntaxError("checkpoint event has an invalid field");
  }
  if (!CONTROLLER_EVENT_TYPES.includes(type as ControllerEventType)) {
    throw new SyntaxError(`checkpoint event has unknown type: ${type}`);
  }
  const detail = JSON.parse(detailJson) as object;
  // 经 createControllerEvent 复算 eventHash;篡改 detailJson/previousHash/type/… 均会失配。
  const rebuilt = createControllerEvent(
    sequence,
    runId,
    type as ControllerEventType,
    detail,
    previousHash,
  );
  if (rebuilt.eventHash !== eventHash) {
    throw new SyntaxError("checkpoint event hash mismatch");
  }
  return rebuilt;
}
