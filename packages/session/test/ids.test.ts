import { describe, expect, it } from "vitest";
import { deriveId } from "../src/ids.js";

describe("deriveId", () => {
  it("是确定性的:相同参数多次调用得到同一 id", () => {
    expect(deriveId("a", 1)).toBe(deriveId("a", 1));
  });

  it("返回 64 位小写十六进制字符串", () => {
    expect(deriveId("a", 1)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("不同参数产生不同 id", () => {
    expect(deriveId("a", 1)).not.toBe(deriveId("a", 2));
    expect(deriveId("a", 1)).not.toBe(deriveId("b", 1));
  });

  it("参数顺序敏感", () => {
    expect(deriveId("a", "b")).not.toBe(deriveId("b", "a"));
    expect(deriveId("a", 1)).not.toBe(deriveId(1, "a"));
  });

  it("无参数时也稳定", () => {
    expect(deriveId()).toBe(deriveId());
    expect(deriveId()).toMatch(/^[0-9a-f]{64}$/);
  });
});
