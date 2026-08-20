import { describe, expect, it } from "vitest";
import { deriveControllerId } from "../src/ids.js";

describe("deriveControllerId", () => {
  it("是确定性的", () => {
    expect(deriveControllerId("node", "run-1", 0)).toBe(
      deriveControllerId("node", "run-1", 0),
    );
  });

  it("返回 64 位小写十六进制字符串", () => {
    expect(deriveControllerId("node", "run-1", 0)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("参数顺序敏感", () => {
    expect(deriveControllerId("node", "a", "b")).not.toBe(
      deriveControllerId("node", "b", "a"),
    );
  });

  it("不同 kind 产生不同 id", () => {
    expect(deriveControllerId("node", "x", 1)).not.toBe(
      deriveControllerId("edge", "x", 1),
    );
  });
});
