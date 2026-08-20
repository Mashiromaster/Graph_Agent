/**
 * MessageStore:哈希链式 append-only 会话历史,经 Storage 读写。
 *
 * 约束:
 * - append-only:每条消息写为 `sessions/${sessionId}/messages.log` 的一整行 JSON;从不改写历史。
 * - 哈希链:entryHash = sha256(canonicalJson(除 entryHash 外的字段));genesis 复用 core GENESIS_HASH。
 * - 单一 hashableFields:append 与 verify 共用同一字段集合定义,写入与校验永不漂移
 *   (子项目 1 事件链评审教训)。结构照抄 core events.ts 的 hashableFields/computeEventHash。
 * - fail-closed:非法 role 直接抛错;被篡改的链使 verifyMessageChain 返回 false(verify 不抛错)。
 * - 确定性:无 Date.now()/Math.random();StoredMessage 无 timestamp 字段。
 * - 复用 core canonicalJson/sha256/GENESIS_HASH,不自行实现哈希。
 */

import { canonicalJson, sha256, GENESIS_HASH } from "@graph-agent/core";
import type { Storage } from "./storage.js";

/** 会话消息角色。此为对话消息角色,与 core 的 MessageProposal(路由提议)无关。 */
export type MessageRole = "user" | "assistant" | "system" | "tool";

/** 有效角色集合,用于 fail-closed 校验。 */
const MESSAGE_ROLES: readonly MessageRole[] = ["user", "assistant", "system", "tool"];

/** 哈希链中的一条不可变消息记录。 */
export interface StoredMessage {
  readonly sequence: number;
  readonly role: MessageRole;
  readonly content: string;
  /** 工具调用的 canonical JSON 序列化(无则为 "[]")。 */
  readonly toolCallsJson: string;
  readonly previousHash: string;
  readonly entryHash: string;
}

/** 参与哈希的字段集合(除 entryHash 外的一切)。 */
interface HashableFields {
  sequence: number;
  role: MessageRole;
  content: string;
  toolCallsJson: string;
  previousHash: string;
}

/**
 * 消息链哈希覆盖字段集合的唯一真源。{@link appendMessage} 与
 * {@link verifyMessageChain} 都经此 helper 构造待哈希对象,使写入与校验的
 * 字段集合永不漂移。返回除 `entryHash` 外的每一个字段。
 */
function hashableFields(entry: HashableFields): HashableFields {
  return {
    sequence: entry.sequence,
    role: entry.role,
    content: entry.content,
    toolCallsJson: entry.toolCallsJson,
    previousHash: entry.previousHash,
  };
}

function computeEntryHash(fields: HashableFields): string {
  return sha256(canonicalJson(hashableFields(fields)));
}

/** 判定 role 是否为合法的 MessageRole。 */
function assertMessageRole(role: string): asserts role is MessageRole {
  if (!MESSAGE_ROLES.includes(role as MessageRole)) {
    throw new Error(`invalid message role: ${JSON.stringify(role)}`);
  }
}

/** 会话消息日志路径,与 SessionDoc 的 `sessions/${sessionId}/...` 布局一致。 */
function messagesLogPath(sessionId: string): string {
  return `sessions/${sessionId}/messages.log`;
}

/**
 * 追加一条消息:从现有历史推导 sequence 与 previousHash,计算 entryHash,
 * 以一整行 JSON 追加到日志,返回冻结的 StoredMessage。
 */
export async function appendMessage(
  storage: Storage,
  sessionId: string,
  msg: { role: MessageRole; content: string; toolCalls?: unknown },
): Promise<StoredMessage> {
  assertMessageRole(msg.role);
  const existing = await readMessages(storage, sessionId);
  const sequence = existing.length;
  const previousHash =
    existing.length > 0 ? existing[existing.length - 1]!.entryHash : GENESIS_HASH;
  const toolCallsJson = canonicalJson(msg.toolCalls ?? []);
  const fields = hashableFields({
    sequence,
    role: msg.role,
    content: msg.content,
    toolCallsJson,
    previousHash,
  });
  const entry: StoredMessage = Object.freeze({
    ...fields,
    entryHash: computeEntryHash(fields),
  });
  await storage.appendLine(messagesLogPath(sessionId), JSON.stringify(entry));
  return entry;
}

/**
 * 读取全部消息;日志缺失则返回 []。每行 JSON.parse 为一条 StoredMessage,
 * 返回冻结数组(元素亦冻结),不改写日志。
 */
export async function readMessages(
  storage: Storage,
  sessionId: string,
): Promise<readonly StoredMessage[]> {
  const lines = await storage.readLines(messagesLogPath(sessionId));
  const messages = lines.map((line) => {
    const parsed = JSON.parse(line) as StoredMessage;
    return Object.freeze({
      sequence: parsed.sequence,
      role: parsed.role,
      content: parsed.content,
      toolCallsJson: parsed.toolCallsJson,
      previousHash: parsed.previousHash,
      entryHash: parsed.entryHash,
    });
  });
  return Object.freeze(messages);
}

/**
 * 校验消息哈希链:逐条要求 sequence===index、previousHash 链接正确
 * (首条为 GENESIS_HASH),并经同一 hashableFields helper 重算 entryHash 比对。
 * 空数组视为有效。发现异常返回 false,绝不抛错(fail-closed)。
 */
export function verifyMessageChain(messages: readonly StoredMessage[]): boolean {
  let previousHash = GENESIS_HASH;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.sequence !== index || message.previousHash !== previousHash) {
      return false;
    }
    const recalculated = computeEntryHash(hashableFields(message));
    if (recalculated !== message.entryHash) {
      return false;
    }
    previousHash = message.entryHash;
  }
  return true;
}
