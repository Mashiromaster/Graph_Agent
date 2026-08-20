/**
 * 编排层确定性 ID 派生。
 *
 * 复用 `@graph-agent/session` 的 `deriveId`(= `sha256(canonicalJson(parts))`),
 * 将 `kind` 作为第一个片段前置,从而不同 kind 必然派生出不同 id。
 */

import { deriveId } from "@graph-agent/session";

/** 由 kind + 有序片段派生控制器实体 id(64 位小写 hex)。 */
export function deriveControllerId(kind: string, ...parts: (string | number)[]): string {
  return deriveId(kind, ...parts);
}
