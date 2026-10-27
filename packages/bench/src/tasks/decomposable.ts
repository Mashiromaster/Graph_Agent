/**
 * 可分解任务族:拓扑效应可测的前提条件。
 *
 * ## 为什么需要这一族(实测依据)
 *
 * 实况探测发现:在算术题上,小档与中档模型都**拒绝**派生子 agent,理由是
 * "delegating to child agents would add overhead without reducing risk"。
 * 这个判断是对的——但它让 A2–A5 全部退化为单节点,五臂变成同一个臂,
 * §6 的拓扑消融没有任何可测内容。测出来的"拓扑无效应"只会是"该任务不需要
 * 拓扑"的同义反复。
 *
 * 为定位真正的派生阈值,我们用同一 A3 配置探测了四种任务结构(小档模型):
 *
 * | 任务结构 | 派生数 |
 * |---|---|
 * | A. 三段独立算术小计 | 0 |
 * | B. 四个互相独立的代码函数 | 0 |
 * | C. 需要独立复核的金融计算 | 0 |
 * | D. 六个各需深度分析的独立研究子问题 | **3** |
 *
 * 结论:触发派生的不是"子问题个数",也不是"复核价值",而是**单次上下文装不下
 * 的产出体量**。A/B/C 的全部工作都能在一轮里做完,派生纯属额外开销;D 要求六
 * 个领域各有真实深度,一轮写不完,分解才有收益。
 *
 * 这一发现本身要写进论文:**任务可分解性是拓扑效应可测的前置条件**,而不是
 * 实验的背景噪声。它也与 AgentPrune 的"更多 agent/边并不更好"一致。
 *
 * ## 评分如何保持确定性
 *
 * 本族是开放式产出,没有唯一数值答案,因此不能用 mathScorer。但评分仍必须是
 * 确定性纯函数(否则评分方差会混进要报告的模型方差)。做法:**覆盖度评分**
 * ——为每个必答子问题给一组必需关键词,按命中的子问题比例给分。关键词匹配是
 * 纯字符串运算,同一输出必得同一分数。
 *
 * 这不是语义评分,也不假装是:它度量的是"六个领域是否都被实际覆盖",
 * 正是分解要解决的问题。局限(可被堆关键词刷分)在论文 §7 如实标注。
 */

import { createTask, score, type Scorer, type TaskInstance } from "../task.js";

/**
 * 一个必答子问题:`required` 里的词**全部**出现才算覆盖(大小写无关)。
 *
 * ## 难度轴是「每项深度」,不是「项数」
 *
 * 这一点由实测定下,值得记录以免后人重走:
 *
 * | 设计 | A1 质量 | 是否可判别 |
 * |---|---|---|
 * | 6 子问题 × 1 关键词 | 0.972(6 格里 5 格满分) | 否,天花板 |
 * | 14 子问题 × 1 关键词 | 0.929 | 否,仍接近天花板 |
 * | 8 子问题 × 3 关键词 | **0.375** | 是,双向都有余量 |
 *
 * 加子问题个数没用:模型在单次上下文里轻松铺开十四个概念名。真正的约束是
 * **每项要给出多个具体机制**——那需要的总深度超出一轮产出,分解才有收益。
 * 实测在深度轴上 A3 稳定派生 3–4 个子节点,而在广度轴上几乎不派生。
 *
 * 这也解释了为什么质量轴的天花板必须先解除再谈样本量:在 A1 恒为 1.00 的设计下,
 * 任何样本量都测不出差异——不是效应不存在,是量具没有刻度。
 */
export interface Subtopic {
  readonly id: string;
  /** 必需词组:全部出现才算覆盖该子问题(大小写无关)。 */
  readonly required: readonly string[];
}

/**
 * 覆盖度评分器:按被覆盖的子问题比例给分。
 *
 * 连续值而非布尔:部分覆盖(4/6)与完全未覆盖(0/6)必须可区分,否则消融
 * 实验会损失大部分信号。
 */
export function coverageScorer(subtopics: readonly Subtopic[]): Scorer {
  if (subtopics.length === 0) {
    throw new Error("coverageScorer requires at least one subtopic");
  }
  return async (output: string | null) => {
    if (output === null || output.trim().length === 0) {
      return score(0, "no output");
    }
    const haystack = output.toLowerCase();
    const covered: string[] = [];
    const missed: string[] = [];
    for (const topic of subtopics) {
      const hit = topic.required.every((term) => haystack.includes(term.toLowerCase()));
      if (hit) {
        covered.push(topic.id);
      } else {
        missed.push(topic.id);
      }
    }
    const value = covered.length / subtopics.length;
    return score(
      value,
      `${covered.length}/${subtopics.length} subtopics covered` +
        (missed.length > 0 ? `; missing: ${missed.join(", ")}` : ""),
    );
  };
}

/**
 * 深度轴的子问题:每项要求**三个具体机制**同时出现。
 *
 * 关键词都选具体机制名(fsync / group commit / LSN),不选领域名(WAL)——
 * 领域名几乎必然被提及,那样的关键词只能测"有没有点到题",测不出深度。
 */
const STORAGE_SUBTOPICS: readonly Subtopic[] = Object.freeze([
  Object.freeze({ id: "wal", required: ["fsync", "group commit", "log sequence number"] }),
  Object.freeze({ id: "mvcc", required: ["snapshot isolation", "write skew", "tuple version"] }),
  Object.freeze({ id: "lsm", required: ["compaction", "bloom filter", "write amplification"] }),
  Object.freeze({ id: "btree", required: ["page split", "fill factor", "clustered index"] }),
  Object.freeze({ id: "2pc", required: ["prepare", "coordinator failure", "blocking"] }),
  Object.freeze({ id: "clocks", required: ["lamport", "vector clock", "causal"] }),
  Object.freeze({ id: "quorum", required: ["r + w", "sloppy quorum", "hinted handoff"] }),
  Object.freeze({ id: "recovery", required: ["checkpoint", "redo", "undo"] }),
]);

const CONSENSUS_SUBTOPICS: readonly Subtopic[] = Object.freeze([
  Object.freeze({ id: "raft", required: ["term", "log matching", "commit index"] }),
  Object.freeze({ id: "paxos", required: ["ballot", "acceptor", "proposal number"] }),
  Object.freeze({ id: "leases", required: ["lease", "clock skew", "fencing token"] }),
  Object.freeze({ id: "membership", required: ["joint consensus", "configuration change", "quorum overlap"] }),
  Object.freeze({ id: "linearizability", required: ["linearizability", "sequential consistency", "real-time order"] }),
  Object.freeze({ id: "failure", required: ["split-brain", "network partition", "fail-stop"] }),
  Object.freeze({ id: "broadcast", required: ["atomic broadcast", "total order", "fifo"] }),
  Object.freeze({ id: "flp", required: ["flp", "asynchronous", "randomization"] }),
]);

const COMPILER_SUBTOPICS: readonly Subtopic[] = Object.freeze([
  Object.freeze({ id: "ssa", required: ["phi", "dominance frontier", "renaming"] }),
  Object.freeze({ id: "aliasing", required: ["points-to", "field-sensitive", "may-alias"] }),
  Object.freeze({ id: "regalloc", required: ["interference graph", "spill", "live range"] }),
  Object.freeze({ id: "inlining", required: ["call site", "code growth", "cost model"] }),
  Object.freeze({ id: "escape", required: ["escape analysis", "stack allocation", "scalar replacement"] }),
  Object.freeze({ id: "vectorization", required: ["dependence", "stride", "unroll"] }),
  Object.freeze({ id: "scheduling", required: ["list scheduling", "latency", "critical path"] }),
  Object.freeze({ id: "loops", required: ["induction variable", "loop-invariant", "strength reduction"] }),
]);

/**
 * 深度轴提示词:显式要求每项至少三个具名机制。
 *
 * "at least three specific named mechanisms" 这句是难度的来源:它把总需求推到
 * 单轮产出之上,使分解有真实收益——实测该表述下 A3 稳定派生 3–4 个子节点,
 * 而广度版提示词几乎不派生。
 */
function deepBriefPrompt(domain: string, areas: readonly string[]): string {
  return [
    `Produce a rigorous technical brief on ${domain}.`,
    "For EACH of the following areas you must discuss at least three specific",
    "named mechanisms in real depth:",
    areas.map((a, i) => `(${i + 1}) ${a}`).join(", "),
    ".",
    "Use precise standard terminology for every mechanism you name.",
    "Be exhaustive: a shallow mention of an area does not count as covering it.",
  ].join(" ");
}

/**
 * 可分解任务族(深度轴)。
 *
 * 三道题同构(八个子问题 × 每项三个机制 + 一次汇总),故族内可做逐实例配对比较;
 * 子问题互不重叠,降低"一段话顺带覆盖多项"的虚假命中。
 */
export function decomposableTasks(): TaskInstance[] {
  return [
    createTask({
      id: "brief-storage",
      family: "decomposable-brief",
      prompt: deepBriefPrompt("database storage and transaction internals", [
        "write-ahead logging",
        "MVCC",
        "LSM trees",
        "B+tree maintenance",
        "two-phase commit",
        "logical clocks",
        "quorum systems",
        "crash recovery",
      ]),
      scorer: coverageScorer(STORAGE_SUBTOPICS),
    }),
    createTask({
      id: "brief-consensus",
      family: "decomposable-brief",
      prompt: deepBriefPrompt("distributed consensus and coordination", [
        "Raft",
        "Paxos",
        "lease-based coordination",
        "membership changes",
        "consistency models",
        "failure modes",
        "atomic broadcast",
        "impossibility results",
      ]),
      scorer: coverageScorer(CONSENSUS_SUBTOPICS),
    }),
    createTask({
      id: "brief-compiler",
      family: "decomposable-brief",
      prompt: deepBriefPrompt("optimizing compiler internals", [
        "SSA construction",
        "alias analysis",
        "register allocation",
        "inlining",
        "escape analysis",
        "loop vectorization",
        "instruction scheduling",
        "loop optimizations",
      ]),
      scorer: coverageScorer(COMPILER_SUBTOPICS),
    }),
  ];
}

/**
 * 不可分解对照族:结构上**不需要**分解的任务。
 *
 * 保留它不是为了凑任务数,而是为了支撑那条实测发现:同一套臂配置下,
 * 任务结构决定模型是否选择派生。两族并列报告,才能把"拓扑无效应"与
 * "该任务不需要拓扑"区分开——否则前者不可证伪。
 */
export function nonDecomposableTasks(): TaskInstance[] {
  return [
    createTask({
      id: "arith-inventory",
      family: "non-decomposable-math",
      prompt: [
        "A library tracks three collections.",
        "Fiction: 8 shelves with 14 books each, minus 12 checked out.",
        "Non-fiction: 6 shelves with 21 books each, minus 18 under repair.",
        "Reference: 4 shelves with 9 books each, plus 7 new arrivals.",
        "Compute the total available across all three collections.",
      ].join(" "),
      scorer: coverageScorer([{ id: "total", required: ["251"] }]),
    }),
  ];
}
