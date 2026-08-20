/**
 * 确定性 ID 派生:`sha256(canonicalJson(parts))`。
 *
 * 约束:
 * - 无随机、无时钟;相同参数(含顺序)恒得同一 64 位小写十六进制串。
 * - 顺序敏感:parts 为数组,`["a",1]` 与 `[1,"a"]` 派生不同 id。
 */

import { canonicalJson, sha256 } from "@graph-agent/core";

/** 由有序的字符串/数字片段派生确定性 id(64 位小写 hex)。 */
export function deriveId(...parts: (string | number)[]): string {
  return sha256(canonicalJson(parts));
}
