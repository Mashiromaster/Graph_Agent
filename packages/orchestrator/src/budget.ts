/**
 * 单写者预算/令牌账本:以不可变 `Ledger` 值 + 纯函数建模。
 *
 * 每个操作返回一个全新的 `Ledger`(绝不修改入参或其 Map),语义与 Python
 * 控制器完全一致:预留(reserve)→ 领取(claim,聚合 reserved 不减)→ 提交
 * (commitSuccess/commitFull,reserved→committed)或释放(release,取消)。
 *
 * 不变量在每次写入新账本时断言:committed≥0、reserved≥0、limit≥1、
 * committed+reserved≤limit。确定性:无 Date/random。整数经 assertBoundedInt 校验。
 */

import { assertBoundedInt } from "@graph-agent/core";
import { createBudgetSnapshot } from "./graph-models.js";
import type { BudgetSnapshot } from "./graph-models.js";

export interface Ledger {
  readonly limitTokens: number;
  readonly committedTokens: number;
  readonly reservedTokens: number;
  readonly nodeReservations: ReadonlyMap<string, number>;
}

/** 校验并冻结新账本,断言全部不变量。 */
function freezeLedger(input: {
  limitTokens: number;
  committedTokens: number;
  reservedTokens: number;
  nodeReservations: Map<string, number>;
}): Ledger {
  const { limitTokens, committedTokens, reservedTokens, nodeReservations } =
    input;
  if (limitTokens < 1) {
    throw new RangeError("limitTokens must be >= 1");
  }
  if (committedTokens < 0) {
    throw new RangeError("committedTokens must be >= 0");
  }
  if (reservedTokens < 0) {
    throw new RangeError("reservedTokens must be >= 0");
  }
  if (committedTokens + reservedTokens > limitTokens) {
    throw new RangeError(
      "committedTokens + reservedTokens must not exceed limitTokens",
    );
  }
  return Object.freeze({
    limitTokens,
    committedTokens,
    reservedTokens,
    nodeReservations: Object.freeze(new Map(nodeReservations)) as ReadonlyMap<
      string,
      number
    >,
  });
}

/** 创建空账本:committed=0、reserved=0、无预留;limitTokens 须为 >=1 整数。 */
export function createLedger(limitTokens: number): Ledger {
  assertBoundedInt(limitTokens, "limitTokens", { min: 1 });
  return freezeLedger({
    limitTokens,
    committedTokens: 0,
    reservedTokens: 0,
    nodeReservations: new Map(),
  });
}

/** 可用额度 = limit - committed - reserved。 */
export function available(ledger: Ledger): number {
  return ledger.limitTokens - ledger.committedTokens - ledger.reservedTokens;
}

/**
 * 为 nodeId 预留 amount(整数 >=1)。amount 超过可用额度或 nodeId 已存在预留时抛错。
 * 返回新账本:reservedTokens += amount,nodeReservations 设 nodeId→amount。
 */
export function reserve(ledger: Ledger, nodeId: string, amount: number): Ledger {
  assertBoundedInt(amount, "amount", { min: 1 });
  if (ledger.nodeReservations.has(nodeId)) {
    throw new Error(`node ${nodeId} already has a reservation`);
  }
  if (amount > available(ledger)) {
    throw new Error("reservation exceeds available budget");
  }
  const nodeReservations = new Map(ledger.nodeReservations);
  nodeReservations.set(nodeId, amount);
  return freezeLedger({
    limitTokens: ledger.limitTokens,
    committedTokens: ledger.committedTokens,
    reservedTokens: ledger.reservedTokens + amount,
    nodeReservations,
  });
}

/**
 * 领取 nodeId 的预留:从 nodeReservations 弹出(缺失则抛错),返回其 amount 与新账本。
 * 聚合 reservedTokens 保持不变——执行期间预留仍占用,调用方保存 amount 至 ExecutionRecord,
 * 后续以 commit/release 调整 reservedTokens。
 */
export function claimReservation(
  ledger: Ledger,
  nodeId: string,
): { ledger: Ledger; amount: number } {
  const amount = ledger.nodeReservations.get(nodeId);
  if (amount === undefined) {
    throw new Error(`no reservation for node ${nodeId}`);
  }
  const nodeReservations = new Map(ledger.nodeReservations);
  nodeReservations.delete(nodeId);
  return {
    amount,
    ledger: freezeLedger({
      limitTokens: ledger.limitTokens,
      committedTokens: ledger.committedTokens,
      reservedTokens: ledger.reservedTokens,
      nodeReservations,
    }),
  };
}

/**
 * 成功路径提交:释放整笔预留(reserved -= reserved),按实际用量提交。
 * actual>reserved → overBudget=true 且提交满额(reserved);否则提交
 * min(max(actual,0),reserved),未用部分隐式释放。
 */
export function commitSuccess(
  ledger: Ledger,
  reserved: number,
  actualTokens: number,
): { ledger: Ledger; overBudget: boolean; committed: number } {
  assertBoundedInt(reserved, "reserved", { min: 1 });
  assertBoundedInt(actualTokens, "actualTokens");
  const overBudget = actualTokens > reserved;
  const committed = overBudget
    ? reserved
    : Math.min(Math.max(actualTokens, 0), reserved);
  return {
    overBudget,
    committed,
    ledger: freezeLedger({
      limitTokens: ledger.limitTokens,
      committedTokens: ledger.committedTokens + committed,
      reservedTokens: ledger.reservedTokens - reserved,
      nodeReservations: new Map(ledger.nodeReservations),
    }),
  };
}

/** 失败/无效/异常路径:提交整笔预留(reserved -= reserved,committed += reserved)。 */
export function commitFull(ledger: Ledger, reserved: number): Ledger {
  assertBoundedInt(reserved, "reserved", { min: 1 });
  return freezeLedger({
    limitTokens: ledger.limitTokens,
    committedTokens: ledger.committedTokens + reserved,
    reservedTokens: ledger.reservedTokens - reserved,
    nodeReservations: new Map(ledger.nodeReservations),
  });
}

/** 取消/阻塞路径:释放预留而不提交(reserved -= reserved,committed 不变)。 */
export function release(ledger: Ledger, reserved: number): Ledger {
  assertBoundedInt(reserved, "reserved", { min: 1 });
  return freezeLedger({
    limitTokens: ledger.limitTokens,
    committedTokens: ledger.committedTokens,
    reservedTokens: ledger.reservedTokens - reserved,
    nodeReservations: new Map(ledger.nodeReservations),
  });
}

/** 导出为 BudgetSnapshot(复用 graph-models 工厂)。 */
export function budgetSnapshot(ledger: Ledger): BudgetSnapshot {
  return createBudgetSnapshot({
    limitTokens: ledger.limitTokens,
    committedTokens: ledger.committedTokens,
    reservedTokens: ledger.reservedTokens,
  });
}
