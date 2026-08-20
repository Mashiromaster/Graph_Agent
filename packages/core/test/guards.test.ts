import { describe, expect, it } from "vitest";
import {
  assertBoolean,
  assertBoundedInt,
  assertNonEmptyText,
  assertSha256Hex,
  assertUnitInterval,
} from "../src/guards.js";

describe("assertNonEmptyText", () => {
  it("returns the value when non-empty", () => {
    expect(assertNonEmptyText("hi", "label")).toBe("hi");
  });
  it("throws RangeError on whitespace-only", () => {
    expect(() => assertNonEmptyText("   ", "label")).toThrow(RangeError);
  });
  it("throws TypeError on non-string", () => {
    expect(() => assertNonEmptyText(1 as unknown as string, "label")).toThrow(
      TypeError,
    );
  });
});

describe("assertBoundedInt", () => {
  it("accepts an int within bounds", () => {
    expect(assertBoundedInt(5, "n", { min: 1, max: 10 })).toBe(5);
  });
  it("rejects booleans posing as ints", () => {
    expect(() =>
      assertBoundedInt(true as unknown as number, "n"),
    ).toThrow(TypeError);
  });
  it("rejects non-integers", () => {
    expect(() => assertBoundedInt(1.5, "n")).toThrow(TypeError);
  });
  it("rejects values below min", () => {
    expect(() => assertBoundedInt(0, "n", { min: 1 })).toThrow(RangeError);
  });
  it("rejects values above max", () => {
    expect(() => assertBoundedInt(11, "n", { max: 10 })).toThrow(RangeError);
  });
});

describe("assertUnitInterval", () => {
  it("accepts 0, 1, and midpoints", () => {
    expect(assertUnitInterval(0, "t")).toBe(0);
    expect(assertUnitInterval(1, "t")).toBe(1);
    expect(assertUnitInterval(0.5, "t")).toBe(0.5);
  });
  it("rejects out-of-range values", () => {
    expect(() => assertUnitInterval(1.1, "t")).toThrow(RangeError);
    expect(() => assertUnitInterval(-0.1, "t")).toThrow(RangeError);
  });
  it("rejects non-finite values", () => {
    expect(() => assertUnitInterval(Number.NaN, "t")).toThrow(RangeError);
  });
});

describe("assertBoolean", () => {
  it("accepts true and false", () => {
    expect(assertBoolean(true, "b")).toBe(true);
    expect(assertBoolean(false, "b")).toBe(false);
  });
  it("rejects non-booleans", () => {
    expect(() => assertBoolean(1 as unknown as boolean, "b")).toThrow(
      TypeError,
    );
  });
});

describe("assertSha256Hex", () => {
  it("accepts a 64-char lowercase hex string", () => {
    expect(assertSha256Hex("a".repeat(64), "h")).toBe("a".repeat(64));
  });
  it("rejects wrong length", () => {
    expect(() => assertSha256Hex("abc", "h")).toThrow(RangeError);
  });
  it("rejects uppercase hex", () => {
    expect(() => assertSha256Hex("A".repeat(64), "h")).toThrow(RangeError);
  });
});
