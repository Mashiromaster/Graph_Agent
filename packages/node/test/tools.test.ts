import { describe, expect, it } from "vitest";
import { FunctionTool, ToolArgumentError } from "../src/tools.js";

describe("FunctionTool", () => {
  it("passes through a string result unchanged", async () => {
    const tool = new FunctionTool({
      name: "echo",
      description: "echoes",
      inputSchema: { type: "object" },
      fn: () => "hello world",
    });
    expect(await tool.invoke({})).toBe("hello world");
  });

  it("serializes a non-string result via canonicalJson", async () => {
    const tool = new FunctionTool({
      name: "obj",
      description: "returns object",
      inputSchema: { type: "object" },
      fn: () => ({ b: 2, a: 1 }),
    });
    expect(await tool.invoke({})).toBe('{"a":1,"b":2}');
  });

  it("awaits async fn results", async () => {
    const tool = new FunctionTool({
      name: "async",
      description: "async fn",
      inputSchema: { type: "object" },
      fn: async (args) => ({ got: args.x }),
    });
    expect(await tool.invoke({ x: 5 })).toBe('{"got":5}');
  });

  it("exposes a frozen definition", () => {
    const tool = new FunctionTool({
      name: "d",
      description: "desc",
      inputSchema: { type: "object" },
      fn: () => "",
    });
    expect(tool.definition).toEqual({
      name: "d",
      description: "desc",
      inputSchema: { type: "object" },
    });
    expect(Object.isFrozen(tool.definition)).toBe(true);
  });

  it("propagates a thrown fn error", async () => {
    const tool = new FunctionTool({
      name: "boom",
      description: "throws",
      inputSchema: { type: "object" },
      fn: () => {
        throw new ToolArgumentError("bad input");
      },
    });
    await expect(tool.invoke({})).rejects.toThrow("bad input");
  });

  it("ToolArgumentError sets its name", () => {
    const err = new ToolArgumentError("x");
    expect(err.name).toBe("ToolArgumentError");
    expect(err).toBeInstanceOf(Error);
  });
});
