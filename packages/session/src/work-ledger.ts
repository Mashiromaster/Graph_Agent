/**
 * WorkLedger:一个 session 下可有 MULTIPLE open work,幂等 open / 幂等 settle。
 *
 * 约束:
 * - workId 确定性:`deriveId(sessionId, correlationKey, seq)`;同 (correlationKey, seq) → 同 workId。
 * - put-if-absent 幂等:open/settle 均以 createOnce 落盘,命中 FileExistsError 则短路(不覆盖、不抛)。
 * - 记录冻结、canonicalJson 确定性序列化;无 Date.now()/Math.random()。
 * - executionId 退位:`workExecutionId` 为 workId 的只读投影,永不持久化。
 * - InMemoryStorage / FileStorage 同语义(尤其 openWorkItems 的 list 解析)。
 */

import { assertNonEmptyText, canonicalJson } from "@graph-agent/core";
import { deriveId } from "./ids.js";
import { FileExistsError } from "./storage.js";
import type { Storage } from "./storage.js";

const OPEN_SUFFIX = ".open.json";
const SETTLED_SUFFIX = ".settled.json";

/** 该 session 的 work 目录逻辑路径。 */
function workDir(sessionId: string): string {
  return `sessions/${sessionId}/work`;
}

/** 从逻辑路径(可能是 basename 或带前缀的相对路径)取末段 basename。 */
function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

/**
 * 打开一份 work(put-if-absent 幂等)。
 * 同 (sessionId, correlationKey, seq) 恒得同一 workId;重复 open 返回既有 workId,不覆盖既有记录。
 */
export async function openWork(
  storage: Storage,
  sessionId: string,
  correlationKey: string,
  payload: unknown,
  seq: number,
): Promise<string> {
  assertNonEmptyText(sessionId, "sessionId");
  assertNonEmptyText(correlationKey, "correlationKey");
  const workId = deriveId(sessionId, correlationKey, seq);
  const record = Object.freeze({
    workId,
    correlationKey,
    payloadJson: canonicalJson(payload),
    seq,
  });
  try {
    await storage.createOnce(
      `${workDir(sessionId)}/${workId}${OPEN_SUFFIX}`,
      canonicalJson(record),
    );
  } catch (err) {
    // 命中既有 open 记录 → 幂等成功:返回既有 workId,不覆盖。其余错误上抛。
    if (!(err instanceof FileExistsError)) {
      throw err;
    }
  }
  return workId;
}

/**
 * 结算一份 work(put-if-absent 幂等)。
 * 二次 settle 命中既有 settled 记录 → 短路,首个 settle 内容为准。
 */
export async function settleWork(
  storage: Storage,
  sessionId: string,
  workId: string,
  result: unknown,
): Promise<void> {
  assertNonEmptyText(sessionId, "sessionId");
  assertNonEmptyText(workId, "workId");
  const record = Object.freeze({
    workId,
    resultJson: canonicalJson(result),
  });
  try {
    await storage.createOnce(
      `${workDir(sessionId)}/${workId}${SETTLED_SUFFIX}`,
      canonicalJson(record),
    );
  } catch (err) {
    if (!(err instanceof FileExistsError)) {
      throw err;
    }
  }
}

/**
 * 列出仍处于 OPEN 状态的 workId:有 `${workId}.open.json` 且无 `${workId}.settled.json`。
 * 缺目录 → []。返回值排序以保持确定性。两种 storage 的 list 返回带前缀相对路径,统一取 basename 后剥后缀。
 */
export async function openWorkItems(
  storage: Storage,
  sessionId: string,
): Promise<readonly string[]> {
  assertNonEmptyText(sessionId, "sessionId");
  const entries = await storage.list(workDir(sessionId));
  const settled = new Set<string>();
  const opened = new Set<string>();
  for (const entry of entries) {
    const name = basename(entry);
    if (name.endsWith(SETTLED_SUFFIX)) {
      settled.add(name.slice(0, -SETTLED_SUFFIX.length));
    } else if (name.endsWith(OPEN_SUFFIX)) {
      opened.add(name.slice(0, -OPEN_SUFFIX.length));
    }
  }
  return [...opened].filter((workId) => !settled.has(workId)).sort();
}

/**
 * workId → executionId 的只读确定性投影(`deriveId(workId, "exec")`)。
 * NEVER persisted:仅计算,不落盘。
 */
export function workExecutionId(workId: string): string {
  return deriveId(workId, "exec");
}
