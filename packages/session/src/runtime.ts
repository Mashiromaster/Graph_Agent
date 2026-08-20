/**
 * Runtime:会话运行状态机,核心不变量为「每会话至多一个 active run」。
 *
 * 约束:
 * - 至多一个 active run:running 状态下再次 startRun 直接抛 IllegalRuntimeTransition(fail-closed)。
 * - 确定性:无 Date.now()/Math.random();updatedAt 来自注入的 `clock`。
 * - 崩溃安全:runtime.json 经 atomicWrite;归档经 createOnce(双重 finish 幂等)。
 * - 排序不变量:finishRun 先归档(createOnce)后翻转 idle,使「已归档但仍 running」可被恢复(Task 8)侦测。
 * - 复用 core 模型与 deriveId,不自行实现哈希/序列化。
 */

import {
  assertBoundedInt,
  assertSha256Hex,
  canonicalJson,
  type AgentInput,
  type AgentResult,
  type NodeStatus,
} from "@graph-agent/core";
import { deriveId } from "./ids.js";
import { FileExistsError, type Storage } from "./storage.js";

/** 运行状态:idle(无活跃 run)或 running(恰有一个 activeRunId)。 */
export interface RuntimeState {
  readonly status: "idle" | "running";
  readonly activeRunId: string | null;
  readonly updatedAt: number;
}

/** 归档结果投影:从 AgentResult 提取确定性、只读的落盘字段。 */
interface ArchivedResult {
  readonly nodeId: string;
  readonly status: NodeStatus;
  readonly output: string | null;
  readonly usage: AgentResult["usage"];
  readonly error: AgentResult["error"];
}

/** 非法状态转移(如 running 时再次 startRun)时抛出。 */
export class IllegalRuntimeTransition extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IllegalRuntimeTransition";
  }
}

/** runtime 状态文件路径,与既有 `sessions/${sessionId}/...` 布局一致。 */
function runtimePath(sessionId: string): string {
  return `sessions/${sessionId}/runtime.json`;
}

/** 归档结果文件路径。 */
function archivePath(sessionId: string, runId: string): string {
  return `sessions/${sessionId}/runs/${runId}.json`;
}

/** 默认冻结的 idle 状态(runtime.json 缺失时返回)。 */
function idleState(updatedAt: number): RuntimeState {
  return Object.freeze({ status: "idle", activeRunId: null, updatedAt });
}

/**
 * 从解析后的对象重建并冻结 RuntimeState,读时 fail-closed 校验字段:
 * 篡改/损坏的 runtime.json 在读取时抛错,而非被 startRun 静默误判为可启动,
 * 从而守住「至多一个 active run」不变量。
 * - status 必须恰为 "idle" 或 "running"。
 * - running 必须有非 null 的 64-hex activeRunId;idle 必须 activeRunId === null。
 * - updatedAt 必须为 >= 0 的整数。
 */
function reconstructState(raw: unknown): RuntimeState {
  if (typeof raw !== "object" || raw === null) {
    throw new IllegalRuntimeTransition("corrupt runtime.json: not an object");
  }
  const { status, activeRunId, updatedAt } = raw as Record<string, unknown>;
  if (status !== "idle" && status !== "running") {
    throw new IllegalRuntimeTransition(
      `corrupt runtime.json: invalid status ${JSON.stringify(status)}`,
    );
  }
  const checkedUpdatedAt = assertBoundedInt(updatedAt as number, "updatedAt", { min: 0 });
  if (status === "running") {
    if (typeof activeRunId !== "string") {
      throw new IllegalRuntimeTransition(
        "corrupt runtime.json: running state must have a non-null activeRunId",
      );
    }
    assertSha256Hex(activeRunId, "activeRunId");
    return Object.freeze({ status, activeRunId, updatedAt: checkedUpdatedAt });
  }
  // status === "idle"
  if (activeRunId !== null) {
    throw new IllegalRuntimeTransition(
      "corrupt runtime.json: idle state must have activeRunId === null",
    );
  }
  return Object.freeze({ status, activeRunId: null, updatedAt: checkedUpdatedAt });
}

/**
 * 读取 runtime 状态;文件缺失则返回默认冻结 idle 状态 `{ idle, null, 0 }`(缺失非损坏)。
 * 读时重建并 fail-closed 校验后冻结。
 */
export async function readRuntime(
  storage: Storage,
  sessionId: string,
): Promise<RuntimeState> {
  if (!(await storage.exists(runtimePath(sessionId)))) {
    return idleState(0);
  }
  const parsed = JSON.parse(await storage.read(runtimePath(sessionId))) as unknown;
  return reconstructState(parsed);
}

/**
 * 启动一次 run:若已 running 则抛 IllegalRuntimeTransition(至多一个活跃 run,fail-closed);
 * 否则派生 runId = deriveId(sessionId,"run",seq),atomicWrite runtime.json 为 running,返回 runId。
 * agentInput 保留于签名以对齐规划(未来归档用),当前不落盘。
 */
export async function startRun(
  storage: Storage,
  sessionId: string,
  agentInput: AgentInput,
  seq: number,
  clock: () => number,
): Promise<string> {
  void agentInput;
  const current = await readRuntime(storage, sessionId);
  if (current.status === "running") {
    throw new IllegalRuntimeTransition(
      `session ${sessionId} already has an active run: ${current.activeRunId}`,
    );
  }
  const runId = deriveId(sessionId, "run", seq);
  const next: RuntimeState = Object.freeze({
    status: "running",
    activeRunId: runId,
    updatedAt: clock(),
  });
  await storage.atomicWrite(runtimePath(sessionId), canonicalJson(next));
  return runId;
}

/**
 * 结束一次 run:
 * 1. 幂等短路:归档文件已存在则直接返回(双重 finish 是 no-op,不重复归档、不报错)。
 * 2. createOnce 写归档投影(nodeId/status/output/usage/error);并发双重 finish 命中
 *    FileExistsError 时按「已归档」短路处理,不外抛。
 * 3. atomicWrite runtime.json 翻回 idle。
 * 排序:归档在前、翻转 idle 在后,使崩溃于二者之间时留下「已归档但仍 running」供恢复侦测。
 */
export async function finishRun(
  storage: Storage,
  sessionId: string,
  runId: string,
  agentResult: AgentResult,
  clock: () => number,
): Promise<void> {
  const path = archivePath(sessionId, runId);
  if (await storage.exists(path)) {
    return;
  }
  const projection: ArchivedResult = {
    nodeId: agentResult.nodeId,
    status: agentResult.status,
    output: agentResult.output,
    usage: agentResult.usage,
    error: agentResult.error,
  };
  try {
    await storage.createOnce(path, canonicalJson(projection));
  } catch (err) {
    if (err instanceof FileExistsError) {
      // 并发双重 finish:另一路已归档,视为已完成 → 短路,不重复翻转。
      return;
    }
    throw err;
  }
  const idle: RuntimeState = idleState(clock());
  await storage.atomicWrite(runtimePath(sessionId), canonicalJson(idle));
}
