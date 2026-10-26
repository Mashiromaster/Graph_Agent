/**
 * 任务与评分器契约。
 *
 * ## 为什么只收程序化可判定的任务
 *
 * 论文的核心声明是「运行时贡献零熵」,其价值在于把实验中的全部熵归因于模型。
 * 若评分本身引入噪声(LLM-as-judge、人工评分),这个归因就被污染了——分数的
 * 方差里会混进评分器的方差,而我们恰恰要把方差作为头条指标来报告。
 *
 * 因此评分器必须是**确定性纯函数**:同一份输出必得同一分数。这一条直接决定了
 * 可用的任务族只有两个(数学与可单测代码生成),调研 §14 列的另外四个
 * (引用验证研究、多约束规划、文档生成+规则检查)都缺确定性判据,留作附录扩展。
 *
 * ## 分数值域
 *
 * `[0,1]`,1 为完全正确。连续值而非布尔:代码生成按通过的单测比例给分,
 * 使部分正确可被区分——否则「全错」与「差一个边界条件」不可分辨,
 * 消融实验会损失大量信号。
 */

/** 评分结果。`detail` 仅用于诊断,不参与任何统计。 */
export interface Score {
  /** [0,1],1 = 完全正确。 */
  readonly value: number;
  /** 人类可读的判定依据,写入 JSONL 便于事后排查。 */
  readonly detail: string;
}

/**
 * 评分器:给定 agent 的最终输出文本,返回分数。
 *
 * 必须是确定性的,且不得有外部副作用(除 codegen 评分器受控的子进程执行)。
 * 允许异步,因为 codegen 需要起子进程。
 */
export type Scorer = (output: string | null) => Promise<Score>;

/** 一道题。 */
export interface TaskInstance {
  /** 稳定标识,进 JSONL 并用于配对比较(逐实例配对,不是裸均值差)。 */
  readonly id: string;
  /** 任务族标签,用于分族汇总。 */
  readonly family: string;
  /** 交给 root agent 的任务文本。 */
  readonly prompt: string;
  readonly scorer: Scorer;
}

/** 构造一道题(冻结,防止实验过程中被意外改写)。 */
export function createTask(input: {
  id: string;
  family: string;
  prompt: string;
  scorer: Scorer;
}): TaskInstance {
  if (input.id.trim().length === 0) {
    throw new Error("task id must be non-empty");
  }
  if (input.prompt.trim().length === 0) {
    throw new Error("task prompt must be non-empty");
  }
  return Object.freeze({
    id: input.id,
    family: input.family,
    prompt: input.prompt,
    scorer: input.scorer,
  });
}

/** 便捷构造:满分/零分。 */
export function score(value: number, detail: string): Score {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`score must be in [0,1], got ${value}`);
  }
  return Object.freeze({ value, detail });
}
