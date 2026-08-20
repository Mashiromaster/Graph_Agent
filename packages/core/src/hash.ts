import { createHash } from "node:crypto";

function encode(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new RangeError("canonicalJson does not allow NaN or Infinity");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(encode).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    const body = entries
      .map(([key, item]) => `${JSON.stringify(key)}:${encode(item)}`)
      .join(",");
    return `{${body}}`;
  }
  throw new TypeError(`canonicalJson cannot serialize ${typeof value}`);
}

export function canonicalJson(value: unknown): string {
  return encode(value);
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function valueHash(value: unknown): string {
  return sha256(canonicalJson(value));
}
