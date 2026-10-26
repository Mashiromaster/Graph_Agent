/**
 * 数学任务评分器:对规范化后的数值答案做精确匹配。
 *
 * ## 为什么要规范化而非直接比字符串
 *
 * 模型会把同一个数写成 `1,234`、`1234`、`$1234`、`1234.00`、`**1234**`,
 * 也会在末尾加句号。若不规范化,评分器测的就是格式服从度而不是解题正确率,
 * 而格式服从度在不同 arm 之间可能系统性不同(例如多 agent 臂多一道总结环节,
 * 更可能产出带 markdown 的文本),那会是一个与拓扑混淆的伪效应。
 *
 * ## 答案抽取策略
 *
 * 优先级:显式标记 > 最后一个数字。
 *   1. `#### 42` / `答案: 42` / `Answer: 42` 等显式标记后的第一个数;
 *   2. 否则取文本中**最后**一个数字——agent 的结论通常在末尾。
 * 两者都失败则 0 分并在 detail 里说明,便于区分「答错」与「没给出答案」。
 *
 * 确定性:纯函数,无 Date/random/IO。
 */

import { score, type Score, type Scorer } from "../task.js";

/** 显式答案标记(不区分大小写);每个后面紧跟答案。 */
const ANSWER_MARKERS = [
  "####",
  "final answer:",
  "final answer is",
  "the answer is",
  "answer:",
  "答案是",
  "答案:",
  "答案：",
  "最终答案:",
  "最终答案：",
];

/** 匹配一个带可选符号/千分位/小数的数。 */
const NUMBER_RE = /-?\$?\s*\d[\d,]*(?:\.\d+)?/g;

/**
 * 把一个数字串规范化为规范十进制字符串。
 *
 * 去掉 `$`、千分位逗号与空白;去掉无意义的尾随零(`1234.00` → `1234`);
 * `-0` 归一为 `0`。返回 null 表示不是合法数。
 */
export function normalizeNumber(raw: string): string | null {
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (cleaned.length === 0) {
    return null;
  }
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  // 用 Number 归一化尾随零与 -0,但避免科学计数法:整数走 BigInt 风格的定点表示。
  if (Number.isInteger(parsed)) {
    return String(parsed === 0 ? 0 : parsed);
  }
  // 小数:去掉尾随零。
  return String(parsed);
}

/** 从模型输出中抽取答案数字(规范化后)。 */
export function extractAnswer(output: string): string | null {
  const lower = output.toLowerCase();
  // 1. 显式标记:取最后一个出现的标记(结论通常在后面),再取其后第一个数。
  let markerIndex = -1;
  let markerLength = 0;
  for (const marker of ANSWER_MARKERS) {
    const found = lower.lastIndexOf(marker);
    if (found > markerIndex) {
      markerIndex = found;
      markerLength = marker.length;
    }
  }
  if (markerIndex >= 0) {
    const tail = output.slice(markerIndex + markerLength);
    const match = tail.match(NUMBER_RE);
    if (match !== null && match.length > 0) {
      const normalized = normalizeNumber(match[0]!);
      if (normalized !== null) {
        return normalized;
      }
    }
  }
  // 2. 回退:取全文最后一个数字。
  const all = output.match(NUMBER_RE);
  if (all !== null && all.length > 0) {
    return normalizeNumber(all[all.length - 1]!);
  }
  return null;
}

/**
 * 构造一个数学评分器,比对规范化后的期望答案。
 *
 * 期望答案在构造时即规范化,故 `"1,234"` 与 `"1234"` 等价。
 */
export function mathScorer(expected: string): Scorer {
  const target = normalizeNumber(expected);
  if (target === null) {
    throw new Error(`expected answer is not a number: ${expected}`);
  }
  return async (output: string | null): Promise<Score> => {
    if (output === null || output.trim().length === 0) {
      return score(0, "no output");
    }
    const got = extractAnswer(output);
    if (got === null) {
      return score(0, "no number found in output");
    }
    return got === target
      ? score(1, `matched ${target}`)
      : score(0, `expected ${target}, got ${got}`);
  };
}
