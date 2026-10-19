/**
 * v2 可恢复(resumable)checkpoint:在 v1 六键的事件链快照之上,额外携带足以
 * **重跑未完成节点、复用已完成节点产物**的运行时切片。
 *
 * ## 与 v1 的关系
 *
 * v1 checkpoint(controller.checkpoint / replayCheckpoint)是纯事件链快照:它只
 * 保证从事件链纯函数式重建最终快照。v2 是其**严格超集**——前六键逐字节等同于
 * v1(chainHead/eventCount/events/runId/stateDigest 语义完全一致,仅 schemaVersion
 * 为 2),外加第七键 `resumable`。因此 v2 的 parse 复用 v1 的全部校验(链验证、
 * 拓扑 digest、state digest 复算),再叠加 resumable 的浅层结构校验。
 *
 * ## 依赖方向(裁决 A)
 *
 * orchestrator **不依赖** @graph-agent/node。故 checkpoint 里每个节点的 `spec`
 * 当作 **opaque** 处理:build 时直接以 canonicalJson 序列化 state.specs.get(nodeId)
 * (它已是一份 frozen plain 记录),parse 时原样返回为 plain object。resume(T4)
 * 再用注入的 rehydrate 回调把 plain → AgentSpec。input/result 走 core 的
 * agentInputToDict/agentResultToDict(orchestrator→core 允许)。
 *
 * ## 已完成节点的产物(裁决 C)
 *
 * resume 需要「已完成节点不重跑、直接复用其 AgentResult」。控制器的 processedResults
 * 只存决策,不存结果;故 MutableRunState 增了 archivedResults(见 scheduler 归档点)。
 * 这里把它逐条投影为 {executionId, nodeId, result(core dict)}。
 *
 * 确定性:无 Date/random;数组按稳定键(nodeId / executionId)升序;经 canonicalJson
 * 序列化。fail-closed:parse 任一校验失败即抛错。
 */

import {
  agentInputToDict,
  agentResultToDict,
  canonicalJson,
  sha256,
  type AgentInput,
} from "@graph-agent/core";
import {
  runSnapshotToDict,
  type NodeRecord,
  type RunSnapshot,
} from "./graph-models.js";
import {
  snapshotOf,
  type MutableRunState,
} from "./mutable-state.js";
import {
  CONTROLLER_GENESIS_HASH,
  assertNoDuplicateKeys,
  type ControllerEvent,
} from "./controller-events.js";
import {
  GraphController,
  MAX_CHECKPOINT_BYTES,
  rebuildEvent,
} from "./controller.js";

const RESUMABLE_SCHEMA_VERSION = 2 as const;

/** v2 checkpoint 的顶层键集(排序,供严格键集校验)。 */
const RESUMABLE_CHECKPOINT_KEYS = [
  "chainHead",
  "eventCount",
  "events",
  "resumable",
  "runId",
  "schemaVersion",
  "stateDigest",
];

/** resumable 切片里一个节点的运行时描述。spec 为 opaque plain 记录;input 为 core dict。 */
export interface ResumableNode {
  readonly nodeId: string;
  readonly spec: unknown;
  readonly input: unknown;
  readonly toolNames: readonly string[];
  readonly reservation: number;
  readonly state: string;
  /**
   * 节点的模型绑定;`null` 表示未指定。携带它是异质图可 resume 的前提——
   * spec 虽为 opaque 且通常已含 modelKind,但 resume 重建 NodeRecord 时需要
   * 一个不依赖 rehydrateSpec 实现的权威来源。
   */
  readonly modelKind: string | null;
}

/** 一条已完成执行的归档产物:result 为 core 的 AgentResult dict。 */
export interface ResumableArchivedResult {
  readonly executionId: string;
  readonly nodeId: string;
  readonly result: unknown;
}

/** resumable 切片:重跑未完成节点 + 复用已完成节点产物所需的一切。 */
export interface ResumableSlice {
  readonly nodes: readonly ResumableNode[];
  readonly archivedResults: readonly ResumableArchivedResult[];
  readonly enqueueSequence: number;
}

/** v2 可恢复 checkpoint 的顶层结构(v1 六键 + resumable)。 */
export interface ResumableCheckpoint {
  readonly chainHead: string;
  readonly eventCount: number;
  readonly events: readonly ControllerEvent[];
  readonly runId: string;
  readonly schemaVersion: 2;
  readonly stateDigest: string;
  readonly resumable: ResumableSlice;
}

/** parse 的返回:重建的事件、最终快照、以及原样的 resumable 切片(spec/input/result 仍为 plain)。 */
export interface ParsedResumableCheckpoint {
  readonly events: ControllerEvent[];
  readonly finalSnapshot: RunSnapshot;
  readonly resumable: ResumableSlice;
}

/**
 * 由可变状态 + 事件链构造 v2 可恢复 checkpoint 的 canonicalJson 串。
 *
 * 前六键与 v1 checkpoint() 完全一致(chainHead / eventCount / events 浅拷贝 /
 * runId / schemaVersion=2 / stateDigest = sha256(canonicalJson(snapshot dict)))。
 * resumable.nodes 覆盖 state.nodes 全部节点;spec 原样(opaque),input/result 走 core dict。
 */
export function buildResumableCheckpoint(
  state: MutableRunState,
  events: readonly ControllerEvent[],
): string {
  const chainHead =
    events.length > 0 ? events[events.length - 1]!.eventHash : CONTROLLER_GENESIS_HASH;
  const stateDigest = sha256(canonicalJson(runSnapshotToDict(snapshotOf(state))));

  // 注意:此处为「线格式」投影,不是 ResumableNode(后者 modelKind 必填)。
  // 与 runSnapshotToDict 一致——modelKind 为 null 时整键省略,故同质图的
  // checkpoint 串逐字节不变,既有 v2 文档仍可解析(parse 侧缺失即 null)。
  const nodes: Record<string, unknown>[] = [...state.nodes.values()]
    .sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0))
    .map((node: NodeRecord) => {
      const rawInput = state.inputs.get(node.nodeId);
      return {
        nodeId: node.nodeId,
        // spec 为 opaque:直接携带 state.specs 里的 frozen plain 记录。
        spec: state.specs.get(node.nodeId) ?? null,
        input: rawInput === undefined ? null : agentInputToDict(rawInput as AgentInput),
        toolNames: [...node.allowedToolNames],
        reservation: state.nodeReservations.get(node.nodeId) ?? 0,
        state: node.state,
        ...(node.modelKind !== null ? { modelKind: node.modelKind } : {}),
      };
    });

  const archivedResults: ResumableArchivedResult[] = [...state.archivedResults.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([executionId, result]) => ({
      executionId,
      nodeId: result.nodeId,
      result: agentResultToDict(result),
    }));

  return canonicalJson({
    chainHead,
    eventCount: events.length,
    events: events.map((event) => ({ ...event })),
    resumable: {
      nodes,
      archivedResults,
      enqueueSequence: state.enqueueSequence,
    },
    runId: state.runId,
    schemaVersion: RESUMABLE_SCHEMA_VERSION,
    stateDigest,
  });
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SyntaxError(`${label} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

/** 浅层校验 resumable.nodes 的一项形状(不 rehydrate spec/input——留给 T4)。 */
function parseResumableNode(raw: unknown): ResumableNode {
  const record = asObject(raw, "resumable node");
  const nodeId = record["nodeId"];
  const toolNames = record["toolNames"];
  const reservation = record["reservation"];
  const state = record["state"];
  const modelKind = record["modelKind"];
  if (
    typeof nodeId !== "string" ||
    !Array.isArray(toolNames) ||
    !toolNames.every((name) => typeof name === "string") ||
    typeof reservation !== "number" ||
    typeof state !== "string" ||
    // 缺失(旧 v2 文档)与 null 均合法;出现时必须是字符串。
    (modelKind !== undefined && modelKind !== null && typeof modelKind !== "string")
  ) {
    throw new SyntaxError("resumable node has an invalid field");
  }
  return {
    nodeId,
    spec: record["spec"],
    input: record["input"],
    toolNames: Object.freeze([...(toolNames as string[])]),
    reservation,
    state,
    modelKind: (modelKind as string | undefined) ?? null,
  };
}

/** 浅层校验 resumable.archivedResults 的一项形状(不 rehydrate result——留给 T4)。 */
function parseArchivedResult(raw: unknown): ResumableArchivedResult {
  const record = asObject(raw, "archived result");
  const executionId = record["executionId"];
  const nodeId = record["nodeId"];
  if (typeof executionId !== "string" || typeof nodeId !== "string") {
    throw new SyntaxError("archived result has an invalid field");
  }
  return { executionId, nodeId, result: record["result"] };
}

/**
 * 严格解析 v2 可恢复 checkpoint 串。
 *
 * 流程:长度上限 → 全深度拒重复键 → JSON.parse → 顶层键集恰为 7 键 →
 * schemaVersion===2(v1 的 6 键/schemaVersion=1 文档在此报错) → events 数组经
 * 与 v1 完全一致的 rebuildEvent 复算校验 → header 一致(eventCount / chainHead /
 * runId) → GraphController.replay(events) 重建 finalSnapshot(复验链 + 拓扑 digest)
 * → 复算 stateDigest 一致。最后浅层校验 resumable 的 nodes[]/archivedResults[]/
 * enqueueSequence 形状。任一失败即抛错(fail-closed)。
 */
export function parseResumableCheckpoint(json: string): ParsedResumableCheckpoint {
  if (typeof json !== "string") {
    throw new TypeError("checkpoint must be a string");
  }
  if (json.length > MAX_CHECKPOINT_BYTES) {
    throw new RangeError("checkpoint exceeds maximum size");
  }
  assertNoDuplicateKeys(json);
  const parsed = JSON.parse(json) as unknown;
  const root = asObject(parsed, "checkpoint");

  const keys = Object.keys(root).sort();
  if (
    keys.length !== RESUMABLE_CHECKPOINT_KEYS.length ||
    !RESUMABLE_CHECKPOINT_KEYS.every((k, i) => keys[i] === k)
  ) {
    // v1 文档缺 `resumable` 键 → 落在此处;给出明确诊断。
    if (root["schemaVersion"] === 1) {
      throw new SyntaxError("checkpoint v1 does not carry resumable state");
    }
    throw new SyntaxError("resumable checkpoint has an unexpected key set");
  }
  if (root["schemaVersion"] !== RESUMABLE_SCHEMA_VERSION) {
    if (root["schemaVersion"] === 1) {
      throw new SyntaxError("checkpoint v1 does not carry resumable state");
    }
    throw new SyntaxError("unsupported resumable checkpoint schemaVersion");
  }
  if (!Array.isArray(root["events"])) {
    throw new SyntaxError("checkpoint events must be an array");
  }

  // 事件用与 v1 完全一致的 rebuildEvent(复算 eventHash);注意 event 自身的
  // schemaVersion 仍为 v1 的 1(事件链 schema 未变),仅 checkpoint 外壳是 2。
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

  // v1 校验:链验证 + 拓扑 digest + snapshot 再校验。
  const finalSnapshot = GraphController.replay(events);
  const digest = sha256(canonicalJson(runSnapshotToDict(finalSnapshot)));
  if (root["stateDigest"] !== digest) {
    throw new Error("checkpoint state digest mismatch");
  }

  // resumable 浅层结构校验(spec/input/result 的可 rehydrate 性 + 引用完整性 →
  // 交给 T4 的 resumeController)。
  const resumableRaw = asObject(root["resumable"], "resumable");
  if (!Array.isArray(resumableRaw["nodes"])) {
    throw new SyntaxError("resumable.nodes must be an array");
  }
  if (!Array.isArray(resumableRaw["archivedResults"])) {
    throw new SyntaxError("resumable.archivedResults must be an array");
  }
  if (typeof resumableRaw["enqueueSequence"] !== "number") {
    throw new SyntaxError("resumable.enqueueSequence must be a number");
  }
  const resumable: ResumableSlice = {
    nodes: (resumableRaw["nodes"] as unknown[]).map(parseResumableNode),
    archivedResults: (resumableRaw["archivedResults"] as unknown[]).map(parseArchivedResult),
    enqueueSequence: resumableRaw["enqueueSequence"] as number,
  };

  return { events, finalSnapshot, resumable };
}
