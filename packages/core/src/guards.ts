export function assertNonEmptyText(value: string, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
  if (value.trim().length === 0) {
    throw new RangeError(`${label} must not be empty`);
  }
  return value;
}

export function assertBoundedInt(
  value: number,
  label: string,
  opts: { min?: number; max?: number } = {},
): number {
  if (typeof value !== "number" || typeof value === "boolean") {
    throw new TypeError(`${label} must be a number`);
  }
  if (!Number.isInteger(value)) {
    throw new TypeError(`${label} must be an integer`);
  }
  const { min, max } = opts;
  if (min !== undefined && value < min) {
    throw new RangeError(`${label} must be >= ${min}`);
  }
  if (max !== undefined && value > max) {
    throw new RangeError(`${label} must be <= ${max}`);
  }
  return value;
}

export function assertUnitInterval(value: number, label: string): number {
  if (typeof value !== "number" || typeof value === "boolean") {
    throw new TypeError(`${label} must be a number`);
  }
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`${label} must be within [0, 1]`);
  }
  return value;
}

export function assertBoolean(value: boolean, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`${label} must be a boolean`);
  }
  return value;
}

export function assertSha256Hex(value: string, label: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a string`);
  }
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new RangeError(`${label} must be a 64-char lowercase hex string`);
  }
  return value;
}
