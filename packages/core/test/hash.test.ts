import { describe, expect, it } from "vitest";
import { canonicalJson, sha256, valueHash } from "../src/hash.js";

describe("canonicalJson", () => {
  it("sorts object keys deterministically", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
  });

  it("uses compact separators", () => {
    expect(canonicalJson([1, 2, { x: 3 }])).toBe('[1,2,{"x":3}]');
  });

  it("preserves non-ASCII characters without escaping", () => {
    expect(canonicalJson({ 名: "值" })).toBe('{"名":"值"}');
  });

  it("throws on NaN", () => {
    expect(() => canonicalJson({ x: Number.NaN })).toThrow(RangeError);
  });

  it("throws on Infinity", () => {
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it("sorts keys recursively in nested objects", () => {
    expect(canonicalJson({ z: { d: 1, c: 2 }, a: 3 })).toBe(
      '{"a":3,"z":{"c":2,"d":1}}',
    );
  });
});

describe("sha256", () => {
  it("returns a 64-char lowercase hex string", () => {
    const digest = sha256("hello");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});

describe("valueHash", () => {
  it("is stable across key orderings", () => {
    expect(valueHash({ a: 1, b: 2 })).toBe(valueHash({ b: 2, a: 1 }));
  });

  it("changes when a value changes", () => {
    expect(valueHash({ a: 1 })).not.toBe(valueHash({ a: 2 }));
  });
});
