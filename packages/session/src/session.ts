/**
 * Session 门面:聚合 Tasks 3-7 的模块,提供单写者(single-writer)语义的会话 API。
 *
 * 约束:
 * - 单写者:每个 WRITE 方法在公有边界处以 storage.withLock(`sessions/${sessionId}/.lock`, …)
 *   包一次锁。withLock 不可重入(见 InMemoryStorage.withLock 的 per-path promise 队列),
 *   故绝不在同一路径上嵌套加锁 —— deliver 内部直接调模块级 appendMessage(未加锁),
 *   不调 this.appendMessage()(那会在同一 .lock 上二次加锁而死锁)。
 * - 只读 getter(readMessages/readRuntime/openWorkItems/pendingDeliveries/deliveryStatus)
 *   不加锁(纯读)。recover() 亦纯读,只读地暴露为方法。
 * - 确定性:createdAt 于 open 注入;run 时间戳经注入的 clock。无 Date.now()/Math.random()。
 * - fail-closed:load 在 SessionDoc 缺失时抛错。
 * - 复用既有模块,不重实现其逻辑。
 */

import type { AgentInput, AgentResult, AgentIdentity } from "@graph-agent/core";
import type { Storage } from "./storage.js";
import { createSessionDoc, writeSessionDoc, readSessionDoc } from "./session-doc.js";
import {
  appendMessage as appendMessageToStore,
  readMessages,
  type MessageRole,
  type StoredMessage,
} from "./message-store.js";
import { startRun, finishRun, readRuntime, type RuntimeState } from "./runtime.js";
import { openWork, settleWork, openWorkItems } from "./work-ledger.js";
import {
  putIfAbsent,
  ackAfterHistory,
  deliveryStatus,
  pendingDeliveries,
  type DeliveryStatus,
} from "./inbox.js";
import { recoverSession, type RecoverySnapshot } from "./recovery.js";

/** 一条会话消息的输入投影(与 message-store.appendMessage 的入参同构)。 */
export interface MessageInput {
  role: MessageRole;
  content: string;
  toolCalls?: unknown;
}

/** 单写者临界区锁路径,与既有 `sessions/${sessionId}/...` 布局一致。 */
function lockPath(sessionId: string): string {
  return `sessions/${sessionId}/.lock`;
}

/**
 * 会话门面。经 open/load 静态工厂创建;私有构造。所有写方法在公有边界处加一次锁。
 */
export class Session {
  private constructor(
    private readonly storage: Storage,
    private readonly sessionId: string,
  ) {}

  /**
   * 创建会话:构造并 atomicWrite SessionDoc,返回门面。
   * createdAt 注入以保确定性;metadata 可选。atomicWrite 幂等可重复,故 open 对已存在的
   * 会话表现为覆盖式重写 SessionDoc(简单、安全)。
   */
  static async open(
    storage: Storage,
    sessionId: string,
    agentIdentity: AgentIdentity,
    createdAt: number,
    metadata?: Readonly<Record<string, unknown>>,
  ): Promise<Session> {
    const doc = createSessionDoc({
      sessionId,
      agentIdentity,
      createdAt,
      ...(metadata !== undefined ? { metadata } : {}),
    });
    await writeSessionDoc(storage, sessionId, doc);
    return new Session(storage, sessionId);
  }

  /** 加载已存在会话:读 SessionDoc 以确认存在(缺失即抛,fail-closed),返回门面。 */
  static async load(storage: Storage, sessionId: string): Promise<Session> {
    await readSessionDoc(storage, sessionId);
    return new Session(storage, sessionId);
  }

  // ---- 写方法:公有边界处加一次锁 ----

  /** 追加一条消息(哈希链)。 */
  async appendMessage(msg: MessageInput): Promise<StoredMessage> {
    return this.storage.withLock(lockPath(this.sessionId), () =>
      appendMessageToStore(this.storage, this.sessionId, msg),
    );
  }

  /** 启动一次 run(至多一个 active run;running 时再启动会抛错)。 */
  async startRun(agentInput: AgentInput, seq: number, clock: () => number): Promise<string> {
    return this.storage.withLock(lockPath(this.sessionId), () =>
      startRun(this.storage, this.sessionId, agentInput, seq, clock),
    );
  }

  /** 结束一次 run(先归档后翻 idle;双重 finish 幂等)。 */
  async finishRun(
    runId: string,
    agentResult: AgentResult,
    clock: () => number,
  ): Promise<void> {
    return this.storage.withLock(lockPath(this.sessionId), () =>
      finishRun(this.storage, this.sessionId, runId, agentResult, clock),
    );
  }

  /** 打开一份 work(put-if-absent 幂等)。 */
  async openWork(correlationKey: string, payload: unknown, seq: number): Promise<string> {
    return this.storage.withLock(lockPath(this.sessionId), () =>
      openWork(this.storage, this.sessionId, correlationKey, payload, seq),
    );
  }

  /** 结算一份 work(put-if-absent 幂等)。 */
  async settleWork(workId: string, result: unknown): Promise<void> {
    return this.storage.withLock(lockPath(this.sessionId), () =>
      settleWork(this.storage, this.sessionId, workId, result),
    );
  }

  /**
   * 投递一条跨 session 消息:putIfAbsent(envelope) 落盘;首次 accepted 则经 ackAfterHistory
   * 先把消息写入历史(history-before-ACK)再写 receipt;duplicate 则短路,不重复入历史。
   *
   * 死锁规避:整个流程在单个外层 withLock 内运行;ackAfterHistory 的回调直接调模块级
   * appendMessageToStore(未加锁),绝不调 this.appendMessage()(那会二次加同一锁而死锁,
   * 因 withLock 不可重入)。
   */
  async deliver(
    messageId: string,
    envelope: unknown,
    message: MessageInput,
  ): Promise<"accepted" | "duplicate"> {
    return this.storage.withLock(lockPath(this.sessionId), async () => {
      const status = await putIfAbsent(this.storage, this.sessionId, messageId, envelope);
      if (status === "duplicate") {
        // 已投递过:不重复入历史。
        return status;
      }
      await ackAfterHistory(this.storage, this.sessionId, messageId, async () => {
        // 未加锁的模块级 append:外层 withLock 是唯一单写者边界。
        await appendMessageToStore(this.storage, this.sessionId, message);
      });
      return status;
    });
  }

  // ---- 只读 getter:不加锁 ----

  /** 恢复:返回一致的只读快照(纯读,不改写存储)。 */
  async recover(): Promise<RecoverySnapshot> {
    return recoverSession(this.storage, this.sessionId);
  }

  /** 读取全部消息。 */
  async readMessages(): Promise<readonly StoredMessage[]> {
    return readMessages(this.storage, this.sessionId);
  }

  /** 读取 runtime 状态。 */
  async readRuntime(): Promise<RuntimeState> {
    return readRuntime(this.storage, this.sessionId);
  }

  /** 列出仍 OPEN 的 workId。 */
  async openWorkItems(): Promise<readonly string[]> {
    return openWorkItems(this.storage, this.sessionId);
  }

  /** 列出仍待投递的 messageId。 */
  async pendingDeliveries(): Promise<readonly string[]> {
    return pendingDeliveries(this.storage, this.sessionId);
  }

  /** 查询某消息的投递状态。 */
  async deliveryStatus(messageId: string): Promise<DeliveryStatus> {
    return deliveryStatus(this.storage, this.sessionId, messageId);
  }
}
