import { describe, expect, it } from "vitest";
import {
  available,
  budgetSnapshot,
  claimReservation,
  commitFull,
  commitSuccess,
  createLedger,
  release,
  reserve,
} from "../src/budget.js";
import type { Ledger } from "../src/budget.js";

/** 断言账本满足所有不变量。 */
function assertInvariants(ledger: Ledger): void {
  expect(ledger.limitTokens).toBeGreaterThanOrEqual(1);
  expect(ledger.committedTokens).toBeGreaterThanOrEqual(0);
  expect(ledger.reservedTokens).toBeGreaterThanOrEqual(0);
  expect(ledger.committedTokens + ledger.reservedTokens).toBeLessThanOrEqual(
    ledger.limitTokens,
  );
}

describe("createLedger", () => {
  it("默认 committed=0 reserved=0 空 reservations", () => {
    const ledger = createLedger(100);
    expect(ledger.limitTokens).toBe(100);
    expect(ledger.committedTokens).toBe(0);
    expect(ledger.reservedTokens).toBe(0);
    expect(ledger.nodeReservations.size).toBe(0);
    assertInvariants(ledger);
  });

  it("limitTokens 必须 >=1 整数", () => {
    expect(() => createLedger(0)).toThrow();
    expect(() => createLedger(-5)).toThrow();
    expect(() => createLedger(1.5)).toThrow();
  });
});

describe("available", () => {
  it("= limit - committed - reserved", () => {
    const ledger = createLedger(100);
    expect(available(ledger)).toBe(100);
    const r = reserve(ledger, "n1", 30);
    expect(available(r)).toBe(70);
  });
});

describe("reserve", () => {
  it("在可用额度内:reservedTokens+amount + map entry", () => {
    const ledger = createLedger(100);
    const next = reserve(ledger, "n1", 40);
    expect(next.reservedTokens).toBe(40);
    expect(next.nodeReservations.get("n1")).toBe(40);
    // 原账本不变(不可变)
    expect(ledger.reservedTokens).toBe(0);
    expect(ledger.nodeReservations.size).toBe(0);
    assertInvariants(next);
  });

  it("amount 必须整数 >=1", () => {
    const ledger = createLedger(100);
    expect(() => reserve(ledger, "n1", 0)).toThrow();
    expect(() => reserve(ledger, "n1", -1)).toThrow();
    expect(() => reserve(ledger, "n1", 2.5)).toThrow();
  });

  it("超过可用额度 → 抛错", () => {
    const ledger = createLedger(100);
    expect(() => reserve(ledger, "n1", 101)).toThrow(/exceeds available/);
    const partial = reserve(ledger, "n1", 60);
    expect(() => reserve(partial, "n2", 41)).toThrow(/exceeds available/);
  });

  it("同一 nodeId 重复预留 → 抛错", () => {
    const ledger = reserve(createLedger(100), "n1", 30);
    expect(() => reserve(ledger, "n1", 10)).toThrow(/already/);
  });
});

describe("claimReservation", () => {
  it("返回 amount + 移除 map entry + reservedTokens 不变", () => {
    const ledger = reserve(createLedger(100), "n1", 40);
    const { ledger: claimed, amount } = claimReservation(ledger, "n1");
    expect(amount).toBe(40);
    expect(claimed.nodeReservations.has("n1")).toBe(false);
    expect(claimed.reservedTokens).toBe(40); // 未减少
    // 原账本不变
    expect(ledger.nodeReservations.has("n1")).toBe(true);
    assertInvariants(claimed);
  });

  it("缺失 nodeId → 抛错", () => {
    const ledger = createLedger(100);
    expect(() => claimReservation(ledger, "missing")).toThrow(/reservation/);
  });
});

describe("commitSuccess", () => {
  it("under-reserve: actual<reserved → committed=actual, reserved 释放, overBudget false", () => {
    const base = claimReservation(reserve(createLedger(100), "n1", 50), "n1")
      .ledger;
    const { ledger, overBudget, committed } = commitSuccess(base, 50, 30);
    expect(overBudget).toBe(false);
    expect(committed).toBe(30);
    expect(ledger.committedTokens).toBe(30);
    expect(ledger.reservedTokens).toBe(0);
    expect(available(ledger)).toBe(70);
    assertInvariants(ledger);
  });

  it("exactly: actual===reserved", () => {
    const base = claimReservation(reserve(createLedger(100), "n1", 50), "n1")
      .ledger;
    const { ledger, overBudget, committed } = commitSuccess(base, 50, 50);
    expect(overBudget).toBe(false);
    expect(committed).toBe(50);
    expect(ledger.committedTokens).toBe(50);
    expect(ledger.reservedTokens).toBe(0);
    assertInvariants(ledger);
  });

  it("over: actual>reserved → overBudget true, committed=reserved", () => {
    const base = claimReservation(reserve(createLedger(100), "n1", 50), "n1")
      .ledger;
    const { ledger, overBudget, committed } = commitSuccess(base, 50, 80);
    expect(overBudget).toBe(true);
    expect(committed).toBe(50);
    expect(ledger.committedTokens).toBe(50);
    expect(ledger.reservedTokens).toBe(0);
    assertInvariants(ledger);
  });

  it("负数 actual 被夹到 0", () => {
    const base = claimReservation(reserve(createLedger(100), "n1", 50), "n1")
      .ledger;
    const { ledger, committed } = commitSuccess(base, 50, -10);
    expect(committed).toBe(0);
    expect(ledger.committedTokens).toBe(0);
    expect(ledger.reservedTokens).toBe(0);
    assertInvariants(ledger);
  });
});

describe("commitFull", () => {
  it("committed+=reserved, reserved-=reserved", () => {
    const base = claimReservation(reserve(createLedger(100), "n1", 50), "n1")
      .ledger;
    const ledger = commitFull(base, 50);
    expect(ledger.committedTokens).toBe(50);
    expect(ledger.reservedTokens).toBe(0);
    assertInvariants(ledger);
  });
});

describe("release", () => {
  it("reserved-=reserved, committed 不变", () => {
    const base = claimReservation(reserve(createLedger(100), "n1", 50), "n1")
      .ledger;
    const ledger = release(base, 50);
    expect(ledger.committedTokens).toBe(0);
    expect(ledger.reservedTokens).toBe(0);
    expect(available(ledger)).toBe(100);
    assertInvariants(ledger);
  });
});

describe("budgetSnapshot", () => {
  it("映射到 BudgetSnapshot", () => {
    const ledger = reserve(createLedger(100), "n1", 30);
    const snap = budgetSnapshot(ledger);
    expect(snap.limitTokens).toBe(100);
    expect(snap.committedTokens).toBe(0);
    expect(snap.reservedTokens).toBe(30);
  });
});

describe("spawn-budget-gate 场景", () => {
  it("reserve root → claim → commitSuccess with unused → available 回涨未用部分", () => {
    let ledger = createLedger(1000);
    // 为 root 预留 400
    ledger = reserve(ledger, "root", 400);
    expect(available(ledger)).toBe(600);

    // 执行开始:领取预留(reserved 仍占用)
    const claim = claimReservation(ledger, "root");
    ledger = claim.ledger;
    expect(claim.amount).toBe(400);
    expect(available(ledger)).toBe(600); // 领取不改变可用

    // 执行成功,实际只用了 150 → 释放未用的 250
    const commit = commitSuccess(ledger, claim.amount, 150);
    ledger = commit.ledger;
    expect(commit.overBudget).toBe(false);
    expect(commit.committed).toBe(150);
    expect(ledger.committedTokens).toBe(150);
    expect(ledger.reservedTokens).toBe(0);
    // available 回涨:1000 - 150 = 850(未用的 250 归还)
    expect(available(ledger)).toBe(850);
    assertInvariants(ledger);
  });
});
