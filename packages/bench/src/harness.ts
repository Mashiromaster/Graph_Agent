/**
 * 实验 harness:驱动一次 (条件 × 题目 × 种子) 运行,产出一行可复算的记录。
 *
 * ## 为什么每次运行都包一层 RecordingModel
 *
 * transcript 是本工作最强的严谨性资产:交出它,审稿人就能零 API 成本地重放
 * 每一个数字,并自行验证「运行时贡献零熵」。因此录制不是可选项,而是每次运行
 * 的固定开销(内存里一个数组,代价可忽略)。
 *
 * ## 为什么用注入的 clock 而非 Date.now
 *
 * 项目全局的确定性纪律:无 Date.now/Math.random。延迟测量是唯一必须读真实时钟
 * 的地方,故把它隔离在 `wallClock` 参数里——默认用 performance.now,测试里换成
 * 可控计数器,从而 harness 自身的契约测试完全离线且确定。
 *
 * ## 预算对等
 *
 * 不在此处做任何预算核算:上限由 arms.policyFor 设定,由控制器 ledger 强制。
 * harness 只**记录** committedTokens,不裁剪、不筛除超支运行——若出现超支那是
 * 运行时的 bug,应当暴露而非被实验脚本掩盖。
 */

import type { AgentResult } from "@graph-agent/core";
import { createAgentInput } from "@graph-agent/core";
import { RecordingModel, type ModelAdapter, type Transcript } from "@graph-agent/adapter";
import {
  EdgeType,
  GraphController,
  NodeState,
  RunStatus,
  snapshotDigest,
  type NodeFactory,
  type RunSnapshot,
  type TrustTable,
} from "@graph-agent/orchestrator";
import {
  AgentNode,
  agentSpecToDict,
  createAgentSpec,
  type AgentSpec,
} from "@graph-agent/node";
import { policyFor, rootSpecFor, type Condition } from "./arms.js";
import { withSeedMetadata } from "./models.js";
import { conditionKey } from "./arms.js";
import type { TaskInstance } from "./task.js";

/** 一次运行的全部可观测量,一行 JSONL。 */
export interface RunRecord {
  readonly conditionKey: string;
  readonly armId: string;
  readonly fanIn: boolean;
  readonly delivery: boolean;
  readonly taskId: string;
  readonly family: string;
  readonly seed: number;
  readonly model: string;
  /** 快照摘要:replay 验证的锚点。 */
  readonly digest: string;
  readonly runStatus: string;
  /** 程序化评分 [0,1]。 */
  readonly quality: number;
  readonly qualityDetail: string;
  readonly committedTokens: number;
  readonly limitTokens: number;
  readonly latencyMs: number;
  readonly nodeCount: number;
  readonly edgeCount: number;
  readonly maxDepth: number;
  readonly failureCount: number;
  readonly proposalCount: number;
  readonly rejectedCount: number;
  /** 实际注入到某个节点上下文的投递条数。 */
  readonly deliveredCount: number;
  /** skip_context 边中真正产生投递的比例;无 skip 边时为 null。 */
  readonly skipUtilization: number | null;
  readonly modelCalls: number;
}

/** 模型工厂:每个节点一个适配器实例(便于按节点换脚本或注入故障)。 */
export type ModelFactory = (args: {
  nodeId: string;
  role: string;
  seed: number;
}) => ModelAdapter;

export interface HarnessOptions {
  readonly condition: Condition;
  readonly task: TaskInstance;
  readonly seed: number;
  /** 进 JSONL 的模型标识(如 "deepseek-v4-flash")。 */
  readonly modelName: string;
  readonly modelFactory: ModelFactory;
  readonly trustTable?: TrustTable;
  /** 真实时钟,仅用于延迟测量;测试注入可控计数器。 */
  readonly wallClock?: () => number;
}

export interface HarnessResult {
  readonly record: RunRecord;
  readonly snapshot: RunSnapshot;
  /** 合并后的 transcript,供离线重放与补充材料。 */
  readonly transcript: Transcript;
  /** 每个节点实际收到的上下文条数,用于诊断投递。 */
  readonly contextCounts: ReadonlyMap<string, number>;
}

/**
 * 子节点的 system 指令。
 *
 * 编排层不携带 instructions(见工厂里的说明),故由实验侧按角色生成。内容刻意
 * 简短且与臂无关:臂的差异应当只体现在 root 的编排能力与图机制上,子节点的
 * 提示词若随臂变化,就会把提示词工程的效果混进拓扑效应。
 */
function childInstructions(role: string): string {
  return [
    `You are a ${role} agent handling one part of a larger task.`,
    "Address your assigned objective thoroughly and precisely.",
    "Use standard terminology for every mechanism you name.",
    "Return only your own findings; another agent will synthesize them.",
  ].join(" ");
}

/** 从 spawn 边推算最大深度(generation 已在节点上,取最大值即可)。 */
function maxDepthOf(snapshot: RunSnapshot): number {
  let depth = 0;
  for (const node of snapshot.nodes) {
    if (node.generation > depth) {
      depth = node.generation;
    }
  }
  return depth;
}

/** 执行一次运行。 */
export async function runOne(opts: HarnessOptions): Promise<HarnessResult> {
  const { condition, task, seed, modelFactory } = opts;
  const wallClock = opts.wallClock ?? (() => performance.now());
  const policy = policyFor(condition);

  const recorders: RecordingModel[] = [];
  const contextCounts = new Map<string, number>();

  const factory: NodeFactory = {
    create: ({ spec, toolNames }) => {
      const nodeId = spec.identity.nodeId;
      const role = spec.role ?? "worker";
      const recorder = new RecordingModel(modelFactory({ nodeId, role, seed }));
      recorders.push(recorder);
      // 种子标记必须在 AgentNode 与 recorder **之间**:AgentNode 内部用
      // createModelRequest 自建请求(metadata 仅含 turn),故在工厂处包
      // withSeedMetadata 无效——那层在 recorder 内侧,recorder 已按未标记的
      // 请求算过 requestKey。结果是不同种子的同题请求共用一个键,transcript
      // 把 N 个种子的响应堆在一起,重放时种子与响应失去对应关系。
      // 编排层物化子节点时构造的 spec 是 `{identity, budget, role}`——它刻意不
      // 依赖 @graph-agent/node,因此**不带 instructions 与 policy**。而 AgentNode
      // 要求 instructions 为非空串,适配器也直接读 `request.instructions`。
      // 不补这两个字段,每个子节点都会在首次模型调用时抛
      // `TypeError: Cannot read properties of undefined (reading 'trim')`,
      // 被转为结构化 FAILED——表现为 nodes=4 / failureCount=3,看起来像
      // "多 agent 不可靠",实则是跨层 spec 形状不完整。
      const nodeSpec =
        nodeId === "root"
          ? (spec as AgentSpec)
          : createAgentSpec({
              identity: spec.identity,
              budget: spec.budget,
              role,
              instructions: childInstructions(role),
              policy: {
                // 子节点不再派生:本实验只研究两代图,且让子节点继续派生会使
                // 拓扑深度随模型意愿漂移,破坏臂之间的可比性。
                maxGeneration: 0,
                maxChildren: 0,
                allowDirectMessages: false,
                allowSkipContext: false,
              },
            });
      const inner = new AgentNode({
        spec: nodeSpec,
        model: withSeedMetadata(recorder, seed),
        clock: () => 0,
      });
      void toolNames; // 图工具由 AgentNode 内建;本实验不注入本地工具
      return {
        spec: inner.spec,
        run: async (input, signal): Promise<AgentResult> => {
          contextCounts.set(nodeId, input.context.length);
          return inner.run(input, signal);
        },
      };
    },
  };

  const rootSpec = rootSpecFor(condition);
  const rootRunner = factory.create({
    spec: rootSpec as unknown as Parameters<NodeFactory["create"]>[0]["spec"],
    toolNames: [],
  });

  const controller = new GraphController(
    factory,
    policy,
    () => 0,
    opts.trustTable,
  );
  const runId = `${conditionKey(condition)}::${task.id}::${seed}`;
  await controller.createRun(
    runId,
    rootSpec as unknown as Parameters<GraphController["createRun"]>[1],
    rootRunner,
    createAgentInput({ task: task.prompt, context: [], sessionId: runId }),
  );

  const startedAt = wallClock();
  // fanIn 开启时:root 结算后给未运行的子节点之间补依赖边,形成 reducer 模式。
  // 这里走 superstep 粒度而非 runUntilIdle,以便在中途插入依赖边。
  let snapshot = await controller.runSuperstep(runId);
  if (condition.toggles.fanIn && condition.arm.spawn) {
    snapshot = await wireFanIn(controller, runId, snapshot);
  }
  const finalSnapshot = await controller.runUntilIdle(runId);
  const latencyMs = wallClock() - startedAt;

  // 只给**整个运行收敛成功**的结果打分。
  //
  // 仅检查 root 不够:实测出现过 root SUCCEEDED 但 3 个子节点全部
  // token_budget_exceeded 的运行,记录成 `status=failed` 配 `q=0.875`——因为
  // root 在派生前就已写出完整简报,评分器照样给高分。那条记录会让"子节点全死"
  // 在质量轴上变成"还不错",既掩盖了配置错误,也会把失败运行计入均值。
  //
  // 以 runStatus 为准:它由 settleRun 按节点终态收敛,任一节点 FAILED/BLOCKED
  // 即为 failed。这与"预算对等 + fail-closed"的整体立场一致——部分失败的运行
  // 不该贡献质量数据。
  const runSucceeded = finalSnapshot.status === RunStatus.SUCCEEDED;
  const graphOutput = runSucceeded ? await extractGraphOutput(controller, runId) : null;
  const quality = runSucceeded
    ? await task.scorer(graphOutput)
    : { value: 0, detail: `run ${finalSnapshot.status}; output not scored` };

  const transcript: Transcript = Object.freeze({
    entries: Object.freeze(recorders.flatMap((r) => [...r.transcript().entries])),
  });

  let proposalCount = 0;
  let rejectedCount = 0;
  for (const decision of finalSnapshot.decisions) {
    proposalCount += 1;
    if (decision.state === "rejected") {
      rejectedCount += 1;
    }
  }
  let failureCount = 0;
  for (const node of finalSnapshot.nodes) {
    if (node.state === NodeState.FAILED || node.state === NodeState.BLOCKED) {
      failureCount += 1;
    }
  }
  const skipEdges = finalSnapshot.edges.filter((e) => e.type === EdgeType.SKIP_CONTEXT);
  let deliveredCount = 0;
  for (const count of contextCounts.values()) {
    deliveredCount += count;
  }
  // 扣除 spawn 时固有的一条 instructions packet(每个非 root 节点各一条)。
  const spawnPackets = finalSnapshot.nodes.filter((n) => n.parentNodeId !== null).length;
  deliveredCount = Math.max(0, deliveredCount - spawnPackets);

  const record: RunRecord = Object.freeze({
    conditionKey: conditionKey(condition),
    armId: condition.arm.id,
    fanIn: condition.toggles.fanIn,
    delivery: condition.toggles.delivery,
    taskId: task.id,
    family: task.family,
    seed,
    model: opts.modelName,
    digest: snapshotDigest(finalSnapshot),
    runStatus: finalSnapshot.status,
    quality: quality.value,
    qualityDetail: quality.detail,
    committedTokens: finalSnapshot.budget.committedTokens,
    limitTokens: finalSnapshot.budget.limitTokens,
    latencyMs,
    nodeCount: finalSnapshot.nodes.length,
    edgeCount: finalSnapshot.edges.length,
    maxDepth: maxDepthOf(finalSnapshot),
    failureCount,
    proposalCount,
    rejectedCount,
    deliveredCount,
    skipUtilization: skipEdges.length === 0 ? null : deliveredCount / skipEdges.length,
    modelCalls: transcript.entries.length,
  });

  return { record, snapshot: finalSnapshot, transcript, contextCounts };
}

/**
 * fan-in 接线:把先派生的 worker 连到最后派生的那个子节点(视作 reducer)。
 *
 * 选"最后派生"而非按角色名匹配,是为了不依赖模型给出特定 role 字符串——模型
 * 不配合时整个 fan-in 臂就会静默退化成无依赖边,那会是一个难以察觉的失效。
 * 按物化顺序取则总能成立(只要子节点数 ≥2)。
 */
async function wireFanIn(
  controller: GraphController,
  runId: string,
  snapshot: RunSnapshot,
): Promise<RunSnapshot> {
  const children = snapshot.nodes
    .filter((n) => n.parentNodeId !== null && n.state === NodeState.READY)
    .sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0));
  if (children.length < 2) {
    return snapshot;
  }
  const reducer = children[children.length - 1]!;
  let current = snapshot;
  for (const worker of children.slice(0, -1)) {
    current = await controller.addDependency(runId, worker.nodeId, reducer.nodeId);
  }
  return current;
}

/**
 * 取**整张图**的产出:root 与全部子节点的归档输出拼接。
 *
 * ## 为什么不能只取 root
 *
 * 这是整轮实验里影响最大的一个错误,且**系统性地压低每一个派生臂**。
 *
 * BSP 语义决定了 root 不可能综合子节点的产出:root 在第 1 个 superstep 跑完并
 * 进入终态,子节点在第 2 个 superstep 才运行,而节点只执行一次、永不重入
 * (见 GRAPH_CONTROLLER.md)。所以 root 的终文本必然只是一句"已提交子任务、
 * 待其返回后我再综合"。实测一例:root 输出 802 字符的承诺,而三个子节点共产出
 * 25210 字符的真实内容——评分器只看 root,得 0/8;而全图文本里八个子问题的
 * 必需关键词**全部命中**。
 *
 * 换言之,此前 mid 档那 14 个 q=0 的"失败"根本不是失败,是把答案扔掉了。
 * 而且由于只有派生臂有子节点,这个错误只惩罚 A2–A5,不影响 A1——正是会被读成
 * "多 agent 更差"的那种偏差。
 *
 * ## 为什么拼接是正确口径而非权宜
 *
 * 任务要求的产出是"覆盖八个子问题的技术简报"。在图运行时里,这份简报的载体就是
 * 整张图的产出集合;要求它必须出现在单个节点的文本里,等于要求运行时具备
 * 它结构上不具备的能力(节点重入)。覆盖度评分器度量的是"八个领域是否都被实际
 * 覆盖",这正是全图语义下的正确判据。
 *
 * 按 nodeId 排序拼接以保证确定性(archivedResults 的顺序不保证稳定)。
 */
async function extractGraphOutput(
  controller: GraphController,
  runId: string,
): Promise<string | null> {
  // 控制器不暴露 archivedResults;经 v2 checkpoint 取回全部归档结果。
  const json = await controller.checkpointResumable(runId);
  const parsed = JSON.parse(json) as {
    resumable?: { archivedResults?: { nodeId: string; result?: { output?: unknown } }[] };
  };
  const archived = parsed.resumable?.archivedResults ?? [];
  const parts: { nodeId: string; text: string }[] = [];
  for (const entry of archived) {
    const output = entry.result?.output;
    if (typeof output === "string" && output.trim().length > 0) {
      parts.push({ nodeId: entry.nodeId, text: output });
    }
  }
  if (parts.length === 0) {
    return null;
  }
  parts.sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0));
  return parts.map((p) => p.text).join("\n\n");
}

/** 序列化为一行 JSONL。 */
export function toJsonLine(record: RunRecord): string {
  return JSON.stringify(record);
}

void agentSpecToDict;
