import type { ToolDefinition } from "@graph-agent/adapter";
import { canonicalJson } from "@graph-agent/core";

export interface Tool {
  readonly definition: ToolDefinition;
  invoke(args: Record<string, unknown>): Promise<string>;
}

export class ToolArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolArgumentError";
  }
}

export class FunctionTool implements Tool {
  readonly definition: ToolDefinition;
  private readonly fn: (args: Record<string, unknown>) => unknown | Promise<unknown>;

  constructor(input: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    fn: (args: Record<string, unknown>) => unknown | Promise<unknown>;
  }) {
    this.definition = Object.freeze({
      name: input.name,
      description: input.description,
      inputSchema: Object.freeze({ ...input.inputSchema }),
    });
    this.fn = input.fn;
  }

  async invoke(args: Record<string, unknown>): Promise<string> {
    const result = await this.fn(args);
    if (typeof result === "string") {
      return result;
    }
    return canonicalJson(result);
  }
}
