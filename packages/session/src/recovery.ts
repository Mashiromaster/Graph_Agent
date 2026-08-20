/**
 * 崩溃恢复:从落盘真相构造一份一致、只读的会话快照,不改写存储。
 *
 * 约束:
 * - READ-ONLY:recoverSession 绝不写存储(不改写消息日志、不翻转 runtime、不落盘任何东西)。
 *   截断仅作用于返回的内存列表,故「recover 两次 === 同一快照」平凡成立(纯读)。
 * - 消息链截断:整链完好则全用;否则取最长有效前缀(线性增量校验,O(n))。
 * - 归档-但仍-running 调和(承接 Task 5 排序不变量):finishRun 先归档(createOnce
 *   `runs/${runId}.json`)后翻 idle(atomicWrite)。崩溃于二者之间 → runtime 仍 running
 *   但归档已存在 → 该 run 实已完成,视为「未中断」(interruptedRunId=null)。
 *   仅当 running 且无归档文件时,才是真正被中断的 run。
 * - 快照冻结,字段 readonly。
 * - 复用既有模块(readMessages/verifyMessageChain/readRuntime/openWorkItems/pendingDeliveries),
 *   不重实现其逻辑。
 */

import { readMessages, verifyMessageChain, type StoredMessage } from "./message-store.js";
import { readRuntime, runArchivePath, type RuntimeState } from "./runtime.js";
import { openWorkItems } from "./work-ledger.js";
import { pendingDeliveries } from "./inbox.js";
import type { Storage } from "./storage.js";

/** 恢复后的一致视图(冻结,只读)。 */
export interface RecoverySnapshot {
  /** 截断到最后一条完好条目后的消息链(verifyMessageChain 恒为 true)。 */
  readonly messages: readonly StoredMessage[];
  /** 落盘 runtime 状态(经 readRuntime fail-closed 校验)。 */
  readonly runtime: RuntimeState;
  /** 真正被中断的 runId(running 且无归档);否则 null(idle 或 running-但-已归档)。 */
  readonly interruptedRunId: string | null;
  /** 仍处 OPEN 的 workId 列表。 */
  readonly openWork: readonly string[];
  /** 仍待投递(有 env 无 receipt)的 messageId 列表。 */
  readonly pendingDeliveries: readonly string[];
}

/**
 * 求消息链的最长有效前缀。整链完好则原样返回;否则线性扫描,增量校验,
 * 返回使 verifyMessageChain 为 true 的最大前缀。每条 entry 链接前一条,故最长有效
 * 前缀良定义;崩溃残留的尾部损坏/半截条目被截去。
 */
function longestValidPrefix(
  messages: readonly StoredMessage[],
): readonly StoredMessage[] {
  if (verifyMessageChain(messages)) {
    return messages;
  }
  // 线性扫描:找到最大的 k 使 messages.slice(0, k) 完好。
  // 因链是前缀单调的(一旦某条破坏链接/哈希,其后所有更长前缀也不可能有效),
  // 首个失败点即为截断边界。
  let k = 0;
  while (k < messages.length && verifyMessageChain(messages.slice(0, k + 1))) {
    k += 1;
  }
  return messages.slice(0, k);
}

/**
 * 构造一致的恢复快照。纯读:不改写存储,故幂等(recover 两次得深度相等的快照)。
 */
export async function recoverSession(
  storage: Storage,
  sessionId: string,
): Promise<RecoverySnapshot> {
  // 1. 读消息并截断到最后一条完好条目(截断仅作用于内存,不回写日志)。
  const rawMessages = await readMessages(storage, sessionId);
  const messages = longestValidPrefix(rawMessages);

  // 2. 读 runtime(readRuntime 已 fail-closed 校验)。
  const runtime = await readRuntime(storage, sessionId);

  // 3. 调和「归档-但仍-running」:running 且无归档 → 真中断;否则 null。
  let interruptedRunId: string | null = null;
  if (runtime.status === "running" && runtime.activeRunId !== null) {
    const archived = await storage.exists(runArchivePath(sessionId, runtime.activeRunId));
    interruptedRunId = archived ? null : runtime.activeRunId;
  }

  // 4. + 5. 未结算 work 与待投递。
  const openWork = await openWorkItems(storage, sessionId);
  const pending = await pendingDeliveries(storage, sessionId);

  // 6. 返回冻结快照。
  return Object.freeze({
    messages,
    runtime,
    interruptedRunId,
    openWork,
    pendingDeliveries: pending,
  });
}
