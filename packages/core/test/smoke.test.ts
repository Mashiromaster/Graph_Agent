import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "../src/index.js";

describe("package smoke", () => {
  it("exports the package name", () => {
    expect(PACKAGE_NAME).toBe("@graph-agent/core");
  });
});
