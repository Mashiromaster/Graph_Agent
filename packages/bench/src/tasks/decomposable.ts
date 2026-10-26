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

/** 一个必答子问题:命中任一 alias 组内的全部词即视为覆盖。 */
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

/** 数据库内核:六个各需独立分析的子问题(探测中触发派生的结构)。 */
const STORAGE_SUBTOPICS: readonly Subtopic[] = Object.freeze([
  Object.freeze({ id: "wal", required: ["write-ahead"] }),
  Object.freeze({ id: "mvcc", required: ["mvcc"] }),
  Object.freeze({ id: "lsm", required: ["write amplification"] }),
  Object.freeze({ id: "2pc", required: ["two-phase commit"] }),
  Object.freeze({ id: "clocks", required: ["vector clock"] }),
  Object.freeze({ id: "quorum", required: ["quorum"] }),
]);

/** 分布式系统:同构的第二道题,用于族内配对比较。 */
const CONSENSUS_SUBTOPICS: readonly Subtopic[] = Object.freeze([
  Object.freeze({ id: "raft", required: ["raft"] }),
  Object.freeze({ id: "paxos", required: ["paxos"] }),
  Object.freeze({ id: "leases", required: ["lease"] }),
  Object.freeze({ id: "split-brain", required: ["split-brain"] }),
  Object.freeze({ id: "membership", required: ["membership"] }),
  Object.freeze({ id: "linearizability", required: ["linearizability"] }),
]);

/** 编译器:第三道题。 */
const COMPILER_SUBTOPICS: readonly Subtopic[] = Object.freeze([
  Object.freeze({ id: "ssa", required: ["ssa"] }),
  Object.freeze({ id: "aliasing", required: ["alias"] }),
  Object.freeze({ id: "regalloc", required: ["register allocation"] }),
  Object.freeze({ id: "inlining", required: ["inlin"] }),
  Object.freeze({ id: "escape", required: ["escape analysis"] }),
  Object.freeze({ id: "vectorization", required: ["vectoriz"] }),
]);

function briefPrompt(domain: string, areas: readonly string[]): string {
  return [
    `Produce a technical brief on ${domain}, covering six independent areas,`,
    "each requiring its own substantive analysis:",
    areas.map((a, i) => `(${i + 1}) ${a}`).join(", "),
    ".",
    "Each area needs real depth, not a one-line definition.",
    "Name each concept explicitly using its standard terminology.",
  ].join(" ");
}

/**
 * 可分解任务族。
 *
 * 三道题同构(六个独立子问题 + 一次汇总),故族内可做逐实例配对比较;
 * 每道题的子问题互不重叠,降低"一段话顺带覆盖多个子问题"的虚假命中。
 */
export function decomposableTasks(): TaskInstance[] {
  return [
    createTask({
      id: "brief-storage",
      family: "decomposable-brief",
      prompt: briefPrompt("database storage and transaction internals", [
        "write-ahead logging versus shadow paging",
        "MVCC isolation anomalies",
        "B+tree versus LSM write amplification",
        "two-phase commit failure modes",
        "vector clock versus Lamport ordering",
        "quorum sizing trade-offs",
      ]),
      scorer: coverageScorer(STORAGE_SUBTOPICS),
    }),
    createTask({
      id: "brief-consensus",
      family: "decomposable-brief",
      prompt: briefPrompt("distributed consensus and coordination", [
        "Raft leader election",
        "Paxos proposal numbering",
        "lease-based coordination",
        "split-brain prevention",
        "cluster membership changes",
        "linearizability versus sequential consistency",
      ]),
      scorer: coverageScorer(CONSENSUS_SUBTOPICS),
    }),
    createTask({
      id: "brief-compiler",
      family: "decomposable-brief",
      prompt: briefPrompt("optimizing compiler internals", [
        "SSA construction",
        "alias analysis precision",
        "register allocation under pressure",
        "inlining cost models",
        "escape analysis",
        "loop vectorization legality",
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
