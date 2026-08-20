import {
  EventType,
  NodeStatus,
  createAgentIdentity,
  createAgentInput,
  createNodeBudget,
  createUsage,
  verifyEventChain,
} from "@graph-agent/core";
import {
  ScriptedModel,
  createModelResponse,
  createToolCall,
  type ModelAdapter,
  type ModelRequest,
  type ModelResponse,
} from "@graph-agent/adapter";
import { createControllerPolicy, validateResult } from "@graph-agent/orchestrator";
import { describe, expect, it } from "vitest";
import { createAgentSpec } from "../src/spec.js";
import { FunctionTool } from "../src/tools.js";
import { SPAWN_TOOL } from "../src/graph-tools.js";
import { AgentNode } from "../src/agent-node.js";

const NODE_ID = "node-1";

function makeSpec(overrides?: {
  budget?: Parameters<typeof createNodeBudget>[0];
  policy?: Parameters<typeof createAgentSpec>[0]["policy"];
}) {
  return createAgentSpec({
    identity: createAgentIdentity({
      nodeId: NODE_ID,
      name: "root",
      role: "planner",
      generation: 0,
    }),
    budget: createNodeBudget(overrides?.budget),
    instructions: "do the work",
    ...(overrides?.policy !== undefined ? { policy: overrides.policy } : {}),
  });
}

function eventTypes(events: readonly { type: string }[]): string[] {
  return events.map((e) => e.type);
}

describe("AgentNode ctor", () => {
  it("throws on duplicate local tool names", () => {
    const spec = makeSpec();
    const model = new ScriptedModel([]);
    const tool = new FunctionTool({
      name: "echo",
      description: "echo",
      inputSchema: {},
      fn: (a) => a,
    });
    const dup = new FunctionTool({
      name: "echo",
      description: "echo2",
      inputSchema: {},
      fn: (a) => a,
    });
    expect(() => new AgentNode({ spec, model, tools: [tool, dup] })).toThrow();
  });

  it("throws when a local tool uses the reserved graph__ prefix", () => {
    const spec = makeSpec();
    const model = new ScriptedModel([]);
    const bad = new FunctionTool({
      name: "graph__x",
      description: "bad",
      inputSchema: {},
      fn: (a) => a,
    });
    expect(() => new AgentNode({ spec, model, tools: [bad] })).toThrow();
  });
});

describe("AgentNode single-turn complete", () => {
  it("produces a COMPLETED result that passes the orchestrator trust boundary", async () => {
    const spec = makeSpec();
    const model = new ScriptedModel([
      createModelResponse({
        content: "hi",
        usage: createUsage({ inputTokens: 5, outputTokens: 3 }),
      }),
    ]);
    const node = new AgentNode({ spec, model });
    const result = await node.run(createAgentInput({ task: "say hi" }));

    expect(result.status).toBe(NodeStatus.COMPLETED);
    expect(result.output).toBe("hi");
    expect(result.error).toBeNull();
    expect(result.events[0]!.type).toBe(EventType.NODE_STARTED);
    expect(result.events[result.events.length - 1]!.type).toBe(
      EventType.NODE_COMPLETED,
    );
    expect(verifyEventChain(result.events)).toBe(true);
    // THE load-bearing assertion: node output passes the orchestrator boundary.
    expect(validateResult(result, NODE_ID, createControllerPolicy())).toBeNull();
  });
});

describe("AgentNode tool-then-complete", () => {
  it("runs a local tool across two turns and stays orchestrator-valid", async () => {
    const spec = makeSpec();
    const echo = new FunctionTool({
      name: "echo",
      description: "echo back",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
      },
      fn: (args) => `echo:${String(args.text)}`,
    });
    const model = new ScriptedModel([
      createModelResponse({
        content: null,
        toolCalls: [
          createToolCall({ id: "c1", name: "echo", arguments: { text: "yo" } }),
        ],
        usage: createUsage({ inputTokens: 4, outputTokens: 2 }),
      }),
      createModelResponse({
        content: "done",
        usage: createUsage({ inputTokens: 6, outputTokens: 1 }),
      }),
    ]);
    const node = new AgentNode({ spec, model, tools: [echo] });
    const result = await node.run(createAgentInput({ task: "use echo" }));

    expect(result.status).toBe(NodeStatus.COMPLETED);
    expect(result.output).toBe("done");
    const types = eventTypes(result.events);
    expect(types).toContain(EventType.TOOL_STARTED);
    expect(types).toContain(EventType.TOOL_COMPLETED);
    expect(model.requests).toHaveLength(2);
    expect(verifyEventChain(result.events)).toBe(true);
    expect(validateResult(result, NODE_ID, createControllerPolicy())).toBeNull();
  });
});

describe("AgentNode graph tool", () => {
  it("collects a spawn proposal and stays orchestrator-valid", async () => {
    const spec = makeSpec();
    const model = new ScriptedModel([
      createModelResponse({
        content: null,
        toolCalls: [
          createToolCall({
            id: "g1",
            name: SPAWN_TOOL,
            arguments: {
              role: "researcher",
              objective: "find facts",
              instructions: "search",
              budget_share: 0.25,
            },
          }),
        ],
        usage: createUsage({ inputTokens: 3, outputTokens: 2 }),
      }),
      createModelResponse({
        content: "spawned",
        usage: createUsage({ inputTokens: 2, outputTokens: 1 }),
      }),
    ]);
    const node = new AgentNode({ spec, model });
    const result = await node.run(createAgentInput({ task: "spawn one" }));

    expect(result.status).toBe(NodeStatus.COMPLETED);
    expect(result.spawnProposals).toHaveLength(1);
    expect(eventTypes(result.events)).toContain(EventType.PROPOSAL_CREATED);
    expect(verifyEventChain(result.events)).toBe(true);
    expect(validateResult(result, NODE_ID, createControllerPolicy())).toBeNull();
  });
});

describe("AgentNode token budget", () => {
  it("fails with BUDGET_EXCEEDED and binds the error, still orchestrator-valid", async () => {
    const spec = makeSpec({ budget: { maxTotalTokens: 10 } });
    const model = new ScriptedModel([
      createModelResponse({
        content: "too big",
        usage: createUsage({ inputTokens: 40, outputTokens: 40 }),
      }),
    ]);
    const node = new AgentNode({ spec, model });
    const result = await node.run(createAgentInput({ task: "burn tokens" }));

    expect(result.status).toBe(NodeStatus.FAILED);
    expect(result.error?.code).toBe("token_budget_exceeded");
    expect(result.events[result.events.length - 1]!.type).toBe(
      EventType.BUDGET_EXCEEDED,
    );
    expect(verifyEventChain(result.events)).toBe(true);
    // usage capped to policy.maxTotalTokens for the boundary check.
    const policy = createControllerPolicy();
    expect(validateResult(result, NODE_ID, policy)).toBeNull();
  });
});

describe("AgentNode tool budget", () => {
  it("fails with tool_budget_exceeded when maxToolCalls is exhausted", async () => {
    const spec = makeSpec({ budget: { maxToolCalls: 1, maxTurns: 5 } });
    const echo = new FunctionTool({
      name: "echo",
      description: "echo",
      inputSchema: {},
      fn: () => "ok",
    });
    const model = new ScriptedModel([
      createModelResponse({
        content: null,
        toolCalls: [
          createToolCall({ id: "a", name: "echo", arguments: {} }),
          createToolCall({ id: "b", name: "echo", arguments: {} }),
        ],
        usage: createUsage({ inputTokens: 1, outputTokens: 1 }),
      }),
    ]);
    const node = new AgentNode({ spec, model, tools: [echo] });
    const result = await node.run(createAgentInput({ task: "call tools" }));

    expect(result.status).toBe(NodeStatus.FAILED);
    expect(result.error?.code).toBe("tool_budget_exceeded");
    expect(validateResult(result, NODE_ID, createControllerPolicy())).toBeNull();
  });
});

describe("AgentNode turn budget", () => {
  it("fails with turn_budget_exceeded when the model always tool-calls", async () => {
    const spec = makeSpec({ budget: { maxTurns: 2, maxToolCalls: 100 } });
    const echo = new FunctionTool({
      name: "echo",
      description: "echo",
      inputSchema: {},
      fn: () => "ok",
    });
    const toolResp = () =>
      createModelResponse({
        content: null,
        toolCalls: [createToolCall({ id: "x", name: "echo", arguments: {} })],
        usage: createUsage({ inputTokens: 1, outputTokens: 1 }),
      });
    const model = new ScriptedModel([toolResp(), toolResp(), toolResp()]);
    const node = new AgentNode({ spec, model, tools: [echo] });
    const result = await node.run(createAgentInput({ task: "loop forever" }));

    expect(result.status).toBe(NodeStatus.FAILED);
    expect(result.error?.code).toBe("turn_budget_exceeded");
    expect(validateResult(result, NODE_ID, createControllerPolicy())).toBeNull();
  });
});

describe("AgentNode timeout", () => {
  it("fails with timeout when the model never resolves within the budget", async () => {
    const spec = makeSpec({ budget: { timeoutSeconds: 0.02 } });
    const hanging: ModelAdapter = {
      complete(_request: ModelRequest): Promise<ModelResponse> {
        return new Promise<ModelResponse>(() => {
          /* never resolves */
        });
      },
    };
    const node = new AgentNode({ spec, model: hanging });
    const result = await node.run(createAgentInput({ task: "wait" }));

    expect(result.status).toBe(NodeStatus.FAILED);
    expect(result.error?.code).toBe("timeout");
    expect(result.error?.retryable).toBe(true);
    expect(validateResult(result, NODE_ID, createControllerPolicy())).toBeNull();
  });
});

describe("AgentNode model throws", () => {
  it("fails with execution_error and a generic message", async () => {
    const secret = "SECRET_INTERNAL_DETAIL_9f3a";
    const spec = makeSpec();
    const boom: ModelAdapter = {
      complete(): Promise<ModelResponse> {
        return Promise.reject(new Error(secret));
      },
    };
    const node = new AgentNode({ spec, model: boom });
    const result = await node.run(createAgentInput({ task: "explode" }));

    expect(result.status).toBe(NodeStatus.FAILED);
    expect(result.error?.code).toBe("execution_error");
    expect(result.error?.message).not.toContain(secret);
    expect(validateResult(result, NODE_ID, createControllerPolicy())).toBeNull();
  });
});
