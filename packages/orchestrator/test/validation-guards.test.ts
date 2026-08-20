import { describe, expect, it } from "vitest";
import {
  isSha256Hex,
  normalizeTools,
  validateText,
  validateUnit,
} from "../src/validation.js";

describe("validateText", () => {
  it("接受非空字符串并原样返回", () => {
    expect(validateText("x", 10)).toBe("x");
  });

  it("拒绝空字符串", () => {
    expect(() => validateText("", 10)).toThrow(RangeError);
  });

  it("拒绝仅空白的字符串", () => {
    expect(() => validateText("   ", 10)).toThrow(RangeError);
  });

  it("拒绝非字符串", () => {
    expect(() => validateText(123, 10)).toThrow(TypeError);
  });

  it("拒绝超长字符串", () => {
    expect(() => validateText("abcdef", 3)).toThrow(RangeError);
  });

  it("接受恰好达到上限的字符串", () => {
    expect(validateText("abc", 3)).toBe("abc");
  });
});

describe("validateUnit", () => {
  it("接受 0、0.5、1", () => {
    expect(validateUnit(0)).toBe(0);
    expect(validateUnit(0.5)).toBe(0.5);
    expect(validateUnit(1)).toBe(1);
  });

  it("拒绝布尔值 true", () => {
    expect(() => validateUnit(true)).toThrow(TypeError);
  });

  it("拒绝低于 0", () => {
    expect(() => validateUnit(-0.1)).toThrow(RangeError);
  });

  it("拒绝高于 1", () => {
    expect(() => validateUnit(1.1)).toThrow(RangeError);
  });

  it("拒绝 NaN", () => {
    expect(() => validateUnit(NaN)).toThrow(RangeError);
  });

  it("拒绝字符串数字", () => {
    expect(() => validateUnit("0.5")).toThrow(TypeError);
  });

  it("positive 选项下拒绝 0", () => {
    expect(() => validateUnit(0, { positive: true })).toThrow(RangeError);
  });

  it("positive 选项下接受 0.5", () => {
    expect(validateUnit(0.5, { positive: true })).toBe(0.5);
  });
});

describe("normalizeTools", () => {
  it("接受字符串数组并返回冻结数组", () => {
    const result = normalizeTools(["a", "b"], 10);
    expect(result).toEqual(["a", "b"]);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("拒绝裸字符串(不可按字符迭代)", () => {
    expect(() => normalizeTools("ab", 10)).toThrow(TypeError);
  });

  it("拒绝包含空字符串的元素", () => {
    expect(() => normalizeTools([""], 10)).toThrow(RangeError);
  });

  it("拒绝重复项", () => {
    expect(() => normalizeTools(["a", "a"], 10)).toThrow(RangeError);
  });

  it("拒绝超长元素", () => {
    expect(() => normalizeTools(["abcdef"], 3)).toThrow(RangeError);
  });

  it("拒绝非字符串元素", () => {
    expect(() => normalizeTools([1], 10)).toThrow(TypeError);
  });
});

describe("isSha256Hex", () => {
  it("对 64 位小写十六进制返回 true", () => {
    expect(isSha256Hex("a".repeat(64))).toBe(true);
    expect(isSha256Hex("0123456789abcdef".repeat(4))).toBe(true);
  });

  it("对 63 位返回 false", () => {
    expect(isSha256Hex("a".repeat(63))).toBe(false);
  });

  it("对 65 位返回 false", () => {
    expect(isSha256Hex("a".repeat(65))).toBe(false);
  });

  it("对大写返回 false", () => {
    expect(isSha256Hex("A".repeat(64))).toBe(false);
  });

  it("对非十六进制字符返回 false", () => {
    expect(isSha256Hex("g".repeat(64))).toBe(false);
  });

  it("对非字符串返回 false", () => {
    expect(isSha256Hex(123)).toBe(false);
    expect(isSha256Hex(null)).toBe(false);
  });
});
