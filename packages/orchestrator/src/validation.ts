import { assertNonEmptyText } from "@graph-agent/core";

/**
 * Validate that {@link value} is a non-empty (post-trim) string whose length
 * does not exceed {@link limit}. Throws {@link TypeError} for a non-string and
 * {@link RangeError} for empty / too-long input. Returns the value unchanged.
 */
export function validateText(value: unknown, limit: number): string {
  const text = assertNonEmptyText(value as string, "value");
  if (text.length > limit) {
    throw new RangeError(`value must be at most ${limit} characters`);
  }
  return text;
}

/**
 * Validate a unit-interval number in [0, 1]. Booleans are rejected (a boolean
 * is not a number here), as are non-numbers, non-finite values, and values
 * outside the interval. When {@link opts.positive} is set, zero is rejected.
 */
export function validateUnit(value: unknown, opts: { positive?: boolean } = {}): number {
  if (typeof value === "boolean" || typeof value !== "number") {
    throw new TypeError("value must be a number");
  }
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError("value must be within [0, 1]");
  }
  if (opts.positive && value === 0) {
    throw new RangeError("value must be greater than 0");
  }
  return value;
}

/**
 * Normalize a list of tool names into a frozen, duplicate-free array. A bare
 * string is rejected (it must not be treated as a char-by-char iterable); the
 * input must be an array of non-empty strings each no longer than
 * {@link maxLen}.
 */
export function normalizeTools(names: unknown, maxLen: number): readonly string[] {
  if (!Array.isArray(names)) {
    throw new TypeError("tool names must be an array");
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    if (typeof name !== "string") {
      throw new TypeError(`tool names[${index}] must be a string`);
    }
    if (name.trim().length === 0) {
      throw new RangeError(`tool names[${index}] must not be empty`);
    }
    if (name.length > maxLen) {
      throw new RangeError(`tool names[${index}] must be at most ${maxLen} characters`);
    }
    if (seen.has(name)) {
      throw new RangeError(`tool names[${index}] is a duplicate: ${name}`);
    }
    seen.add(name);
    result.push(name);
  }
  return Object.freeze(result);
}

/** Return true iff {@link value} is a 64-char string of lowercase hex digits. */
export function isSha256Hex(value: unknown): boolean {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
