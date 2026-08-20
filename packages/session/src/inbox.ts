/**
 * Inbox/Outbox:跨 session 幂等投递,附 history-before-ACK 顺序保证。
 *
 * 约束:
 * - putIfAbsent 幂等:envelope 以 createOnce 落盘,命中 FileExistsError → "duplicate"(不覆盖)。
 * - history-before-ACK:ackAfterHistory 先 `await appendToHistory()` 使消息持久入 MessageStore,
 *   之后才写 receipt;回调抛错则传播且不写 receipt(投递保持 pending 可重试)。
 * - receipt 写入亦幂等:既有 receipt(FileExistsError)视为已投递,短路不报错。
 * - 记录 canonicalJson 确定性序列化;无 Date.now()/Math.random()。
 * - InMemoryStorage / FileStorage 同语义(尤其 pendingDeliveries 的 list 解析)。
 * - 仅捕获 FileExistsError;其余 IO 错误上抛。
 */

import { assertNonEmptyText, canonicalJson } from "@graph-agent/core";
import { FileExistsError } from "./storage.js";
import type { Storage } from "./storage.js";

/** 投递状态:无 env → none;有 env 无 receipt → pending;有 receipt → delivered。 */
export type DeliveryStatus = "none" | "pending" | "delivered";

const ENV_SUFFIX = ".env.json";
const RECEIPT_SUFFIX = ".receipt.json";

/** 该 session 的 inbox 目录逻辑路径。 */
function inboxDir(sessionId: string): string {
  return `sessions/${sessionId}/inbox`;
}

function envPath(sessionId: string, messageId: string): string {
  return `${inboxDir(sessionId)}/${messageId}${ENV_SUFFIX}`;
}

function receiptPath(sessionId: string, messageId: string): string {
  return `${inboxDir(sessionId)}/${messageId}${RECEIPT_SUFFIX}`;
}

/** 从逻辑路径(basename 或带前缀相对路径)取末段 basename。 */
function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? path : path.slice(slash + 1);
}

/**
 * put-if-absent 落盘 envelope。首次成功 → "accepted";命中既有 → "duplicate"(不覆盖)。
 */
export async function putIfAbsent(
  storage: Storage,
  sessionId: string,
  messageId: string,
  envelope: unknown,
): Promise<"accepted" | "duplicate"> {
  assertNonEmptyText(sessionId, "sessionId");
  assertNonEmptyText(messageId, "messageId");
  try {
    await storage.createOnce(envPath(sessionId, messageId), canonicalJson(envelope));
    return "accepted";
  } catch (err) {
    // 命中既有 envelope → 幂等成功:视为重复,不覆盖。其余错误上抛。
    if (err instanceof FileExistsError) {
      return "duplicate";
    }
    throw err;
  }
}

/**
 * history-before-ACK:先 `await appendToHistory()` 使消息持久入历史,之后才写 receipt。
 * 回调抛错则传播且不写 receipt(投递保持 pending 可重试)。
 * receipt 写入幂等:既有 receipt 视为已投递,短路。
 */
export async function ackAfterHistory(
  storage: Storage,
  sessionId: string,
  messageId: string,
  appendToHistory: () => Promise<void>,
): Promise<void> {
  assertNonEmptyText(sessionId, "sessionId");
  assertNonEmptyText(messageId, "messageId");
  // CRITICAL:历史先于回执。回调抛错则在此传播,receipt 永不写入。
  await appendToHistory();
  const record = Object.freeze({ messageId });
  try {
    await storage.createOnce(
      receiptPath(sessionId, messageId),
      canonicalJson(record),
    );
  } catch (err) {
    // 既有 receipt → 已投递:重试的 ack 幂等短路。其余错误上抛。
    if (!(err instanceof FileExistsError)) {
      throw err;
    }
  }
}

/**
 * 投递状态:无 env → "none";有 receipt → "delivered";有 env 无 receipt → "pending"。
 */
export async function deliveryStatus(
  storage: Storage,
  sessionId: string,
  messageId: string,
): Promise<DeliveryStatus> {
  assertNonEmptyText(sessionId, "sessionId");
  assertNonEmptyText(messageId, "messageId");
  if (await storage.exists(receiptPath(sessionId, messageId))) {
    return "delivered";
  }
  if (await storage.exists(envPath(sessionId, messageId))) {
    return "pending";
  }
  return "none";
}

/**
 * 列出仍待投递的 messageId:有 `${id}.env.json` 且无 `${id}.receipt.json`。
 * 缺目录 → []。返回值排序以保持确定性。两种 storage 的 list 返回带前缀相对路径,
 * 统一取 basename 后剥后缀(先辨 `.receipt.json`,否则 `.env.json`)。
 */
export async function pendingDeliveries(
  storage: Storage,
  sessionId: string,
): Promise<readonly string[]> {
  assertNonEmptyText(sessionId, "sessionId");
  const entries = await storage.list(inboxDir(sessionId));
  const delivered = new Set<string>();
  const enveloped = new Set<string>();
  for (const entry of entries) {
    const name = basename(entry);
    if (name.endsWith(RECEIPT_SUFFIX)) {
      delivered.add(name.slice(0, -RECEIPT_SUFFIX.length));
    } else if (name.endsWith(ENV_SUFFIX)) {
      enveloped.add(name.slice(0, -ENV_SUFFIX.length));
    }
  }
  return [...enveloped].filter((messageId) => !delivered.has(messageId)).sort();
}
