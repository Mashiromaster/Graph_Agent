/**
 * SessionDoc 模型:会话根文档,经 Storage 读写。
 *
 * 约束:
 * - 确定性:createdAt 由调用方注入,工厂内不读时钟。
 * - 不可变:文档与 metadata 均 Object.freeze;interface 字段 readonly。
 * - fail-closed:创建时校验 sessionId 非空、createdAt 为 >=0 的有界整数;
 *   读取时经 createSessionDoc + createAgentIdentity 重建校验,而非直接返回裸解析对象。
 * - 复用 core:createAgentIdentity 负责 identity 校验,guards 负责标量校验,不自行重复实现。
 */

import {
  assertBoundedInt,
  assertNonEmptyText,
  canonicalJson,
  createAgentIdentity,
  type AgentIdentity,
} from "@graph-agent/core";
import type { Storage } from "./storage.js";

/** 当前 SessionDoc 结构版本。 */
const SCHEMA_VERSION = 1;

/** 会话目录布局:`sessions/${sessionId}`。供后续任务复用同一路径约定。 */
function sessionDir(sessionId: string): string {
  return `sessions/${sessionId}`;
}

/** session 根文档路径。 */
function sessionDocPath(sessionId: string): string {
  return `${sessionDir(sessionId)}/session.json`;
}

/** 会话根文档(不可变)。 */
export interface SessionDoc {
  readonly sessionId: string;
  readonly agentIdentity: AgentIdentity;
  readonly createdAt: number;
  readonly schemaVersion: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}

/** 构造经校验、冻结的 SessionDoc;schemaVersion 固定为 1,metadata 默认 {}。 */
export function createSessionDoc(input: {
  sessionId: string;
  agentIdentity: AgentIdentity;
  createdAt: number;
  metadata?: Readonly<Record<string, unknown>>;
}): SessionDoc {
  assertNonEmptyText(input.sessionId, "sessionId");
  assertBoundedInt(input.createdAt, "createdAt", { min: 0 });
  const metadata = Object.freeze({ ...(input.metadata ?? {}) });
  return Object.freeze({
    sessionId: input.sessionId,
    agentIdentity: input.agentIdentity,
    createdAt: input.createdAt,
    schemaVersion: SCHEMA_VERSION,
    metadata,
  });
}

/** 原子写入 session 根文档(canonicalJson 字节)。 */
export async function writeSessionDoc(
  storage: Storage,
  sessionId: string,
  doc: SessionDoc,
): Promise<void> {
  await storage.atomicWrite(sessionDocPath(sessionId), canonicalJson(doc));
}

/** 读取并重建 session 根文档;经工厂重新校验/冻结,不信任裸解析对象(fail-closed)。 */
export async function readSessionDoc(
  storage: Storage,
  sessionId: string,
): Promise<SessionDoc> {
  const raw = await storage.read(sessionDocPath(sessionId));
  const parsed = JSON.parse(raw) as {
    sessionId: string;
    agentIdentity: {
      nodeId: string;
      name: string;
      role: string;
      generation?: number;
      parentNodeId?: string | null;
      trustScore?: number;
    };
    createdAt: number;
    metadata?: Readonly<Record<string, unknown>>;
  };
  const agentIdentity = createAgentIdentity(parsed.agentIdentity);
  return createSessionDoc({
    sessionId: parsed.sessionId,
    agentIdentity,
    createdAt: parsed.createdAt,
    ...(parsed.metadata !== undefined ? { metadata: parsed.metadata } : {}),
  });
}
