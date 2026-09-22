import { describe, expect, it } from "vitest";
import {
  createAgentIdentity,
  createAgentInput,
  createContextPacket,
  createNodeBudget,
  verifyEventChain,
} from "@graph-agent/core";
import { createAgentSpec } from "@graph-agent/node";
import {
  DeepSeekHarnessNode,
  GRAPH_AGENT_HARNESS_PATCH,
  type DeepSeekHarnessOptions,
  type HarnessRunOptions,
  type HarnessRuntime,
  type RunResult,
} from "../src/index.js";

function testSpec(input?: { maxTurns?: number; maxToolCalls?: number }) {
  return createAgentSpec({
    identity: createAgentIdentity({
      nodeId: "root",
      name: "Orchestrator",
      role: "orchestrator",
      generation: 0,
    }),
    budget: createNodeBudget({
      maxTurns: input?.maxTurns ?? 4,
      maxToolCalls: input?.maxToolCalls ?? 4,
      maxTotalTokens: 1_000,
      timeoutSeconds: 5,
    }),
    instructions: "Solve the task and delegate only when useful.",
    role: "orchestrator",
    policy: {
      maxGeneration: 2,
      maxChildren: 2,
      allowDirectMessages: false,
      allowSkipContext: false,
    },
  });
}

function notification(event: Record<string, unknown>) {
  return {
    method: "session.event",
    params: { sessionId: "ignored-by-runner", event },
  };
}

class CompletedRuntime implements HarnessRuntime {
  closeCalls = 0;
  prompt = "";

  async run(input: string, options: HarnessRunOptions): Promise<RunResult> {
    this.prompt = input;
    const events = [
      { type: "turn/start", data: { turn: 1 } },
      {
        type: "tool/call",
        data: {
          turn: 1,
          step: 1,
          callId: "call-1",
          name: "mcp__graph__propose_spawn",
          arguments: JSON.stringify({
            role: "reviewer",
            objective: "Check the proposed answer",
            instructions: "Find concrete mistakes and report them.",
            tool_names: [],
            priority: 0.8,
            budget_share: 0.25,
          }),
        },
      },
      {
        type: "assistant/message",
        data: {
          usage: { inputTokens: 40, outputTokens: 12, totalTokens: 52 },
        },
      },
      {
        type: "tool/result",
        data: {
          turn: 1,
          step: 1,
          message: {
            role: "user",
            content: [
              {
                type: "tool-result",
                toolCallId: "call-1",
                content: [{ type: "text", text: "proposal accepted locally" }],
              },
            ],
            source: { kind: "tool", callId: "call-1" },
          },
        },
      },
      { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
    ];
    for (const event of events) {
      options.onNotification?.(notification(event));
    }
    return {
      sessionId: options.sessionId,
      finalResponse: "I delegated a focused review and produced the answer.",
      events,
      notifications: [],
    } as unknown as RunResult;
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

class NeverEndingRuntime implements HarnessRuntime {
  closeCalls = 0;

  async run(_input: string, options: HarnessRunOptions): Promise<RunResult> {
    options.onNotification?.(notification({ type: "turn/start", data: { turn: 1 } }));
    options.onNotification?.(notification({ type: "turn/start", data: { turn: 2 } }));
    return await new Promise<RunResult>(() => undefined);
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

class ModelErrorRuntime implements HarnessRuntime {
  async run(_input: string, options: HarnessRunOptions): Promise<RunResult> {
    const events = [
      { type: "turn/start", data: { turn: 1 } },
      {
        type: "assistant/message",
        data: { usage: { inputTokens: 9, outputTokens: 3, totalTokens: 12 } },
      },
      {
        type: "turn/end",
        data: {
          turn: 1,
          reason: { kind: "error", error: { code: "UPSTREAM", message: "secret raw error" } },
        },
      },
    ];
    for (const event of events) options.onNotification?.(notification(event));
    return {
      sessionId: options.sessionId,
      finalResponse: "partial text that must not be accepted",
      events,
      notifications: [],
    } as unknown as RunResult;
  }

  async close(): Promise<void> {}
}

class ModelErrorWithoutUsageRuntime implements HarnessRuntime {
  async run(_input: string, options: HarnessRunOptions): Promise<RunResult> {
    const events = [
      { type: "turn/start", data: { turn: 1 } },
      {
        type: "turn/end",
        data: {
          turn: 1,
          reason: { kind: "error", error: { code: "AUTH", message: "raw provider error" } },
        },
      },
    ];
    for (const event of events) options.onNotification?.(notification(event));
    return {
      sessionId: options.sessionId,
      finalResponse: "",
      events,
      notifications: [],
    } as unknown as RunResult;
  }

  async close(): Promise<void> {}
}

class FailedProposalRuntime implements HarnessRuntime {
  async run(_input: string, options: HarnessRunOptions): Promise<RunResult> {
    const events = [
      { type: "turn/start", data: { turn: 1 } },
      {
        type: "tool/call",
        data: {
          turn: 1,
          step: 1,
          callId: "failed-call",
          name: "mcp__graph__propose_spawn",
          arguments: JSON.stringify({
            role: "reviewer",
            objective: "review",
            instructions: "review",
            tool_names: [],
            budget_share: 0.25,
          }),
        },
      },
      {
        type: "tool/result",
        data: {
          turn: 1,
          step: 1,
          message: {
            role: "user",
            content: [
              {
                type: "tool-result",
                toolCallId: "failed-call",
                content: [{ type: "text", text: "proposal rejected locally" }],
                isError: true,
              },
            ],
            source: { kind: "tool", callId: "failed-call" },
          },
          error: { name: "ProposalError", code: "INVALID_PROPOSAL" },
        },
      },
      {
        type: "assistant/message",
        data: { usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 } },
      },
      { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
    ];
    for (const event of events) options.onNotification?.(notification(event));
    return {
      sessionId: options.sessionId,
      finalResponse: "I finished without delegation.",
      events,
      notifications: [],
    } as unknown as RunResult;
  }

  async close(): Promise<void> {}
}

describe("DeepSeekHarnessNode", () => {
  it("maps official Harness events into a controller-verifiable AgentResult", async () => {
    const runtime = new CompletedRuntime();
    let launch: DeepSeekHarnessOptions | undefined;
    let tick = 0;
    const node = new DeepSeekHarnessNode({
      spec: testSpec(),
      apiKey: "sk-test-secret-key",
      model: "deepseek-v4-flash",
      clock: () => ++tick,
      runtimeFactory(options) {
        launch = options;
        return runtime;
      },
    });
    const result = await node.run(
      createAgentInput({
        task: "Design a safe graph agent",
        context: [
          createContextPacket({
            sourceNodeId: "parent",
            content: "Untrusted notes",
            trust: 0.5,
            edgeType: "spawn",
          }),
        ],
        sessionId: "run-1",
      }),
    );

    expect(result.status).toBe("completed");
    expect(result.output).toContain("delegated");
    expect(result.usage).toEqual({ inputTokens: 40, outputTokens: 12 });
    expect(result.spawnProposals).toHaveLength(1);
    expect(result.spawnProposals[0]).toMatchObject({
      parentNodeId: "root",
      generation: 1,
      role: "reviewer",
      priority: 0.8,
      budgetShare: 0.25,
    });
    expect(verifyEventChain(result.events)).toBe(true);
    expect(runtime.prompt).toContain("<untrusted_context_json>");
    expect(runtime.prompt).toContain("Untrusted notes");
    expect(launch?.profile).toBe("sdk-minimal");
    expect(launch?.provider).toBe("deepseek-official");
    expect(launch?.env?.["DEEPSEEK_API_KEY"]).toBe("sk-test-secret-key");
    expect(JSON.stringify(result)).not.toContain("sk-test-secret-key");
    expect(runtime.closeCalls).toBeGreaterThanOrEqual(1);
  });

  it("closes the isolated runtime as soon as the Harness exceeds turn budget", async () => {
    const runtime = new NeverEndingRuntime();
    const node = new DeepSeekHarnessNode({
      spec: testSpec({ maxTurns: 1 }),
      apiKey: "sk-test-secret-key",
      model: "deepseek-v4-flash",
      runtimeFactory: () => runtime,
      clock: () => 0,
    });

    const result = await node.run(createAgentInput({ task: "loop forever" }));

    expect(result.status).toBe("failed");
    expect(result.error).toMatchObject({
      code: "turn_budget_exceeded",
      retryable: false,
    });
    expect(runtime.closeCalls).toBeGreaterThanOrEqual(1);
    expect(verifyEventChain(result.events)).toBe(true);
  });

  it("does not start a Harness process for an already-aborted node", async () => {
    let created = false;
    const node = new DeepSeekHarnessNode({
      spec: testSpec(),
      apiKey: "sk-test-secret-key",
      model: "deepseek-v4-flash",
      runtimeFactory: () => {
        created = true;
        return new CompletedRuntime();
      },
      clock: () => 0,
    });
    const abort = new AbortController();
    abort.abort();

    const result = await node.run(createAgentInput({ task: "cancel" }), abort.signal);

    expect(created).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.error?.message).toBe("The node was cancelled.");
    expect(verifyEventChain(result.events)).toBe(true);
  });

  it("does not treat partial text from a failed Harness turn as success", async () => {
    const node = new DeepSeekHarnessNode({
      spec: testSpec(),
      apiKey: "sk-test-secret-key",
      model: "deepseek-v4-flash",
      runtimeFactory: () => new ModelErrorRuntime(),
      clock: () => 0,
    });

    const result = await node.run(createAgentInput({ task: "fail after partial output" }));

    expect(result.status).toBe("failed");
    expect(result.output).toBeNull();
    expect(result.error).toEqual({
      code: "model_error",
      message: "DeepSeek Harness reported a model execution error.",
      retryable: true,
    });
    expect(JSON.stringify(result)).not.toContain("secret raw error");
    expect(verifyEventChain(result.events)).toBe(true);
  });

  it("classifies a provider failure before requiring success-only usage accounting", async () => {
    const node = new DeepSeekHarnessNode({
      spec: testSpec(),
      apiKey: "sk-invalid-test-key",
      model: "deepseek-v4-flash",
      runtimeFactory: () => new ModelErrorWithoutUsageRuntime(),
      clock: () => 0,
    });

    const result = await node.run(createAgentInput({ task: "fail authentication" }));

    expect(result.status).toBe("failed");
    expect(result.error).toEqual({
      code: "model_error",
      message: "DeepSeek Harness reported a model execution error.",
      retryable: true,
    });
    expect(JSON.stringify(result)).not.toContain("raw provider error");
    expect(verifyEventChain(result.events)).toBe(true);
  });

  it("does not materialize a proposal whose Harness tool execution failed", async () => {
    const node = new DeepSeekHarnessNode({
      spec: testSpec(),
      apiKey: "sk-test-secret-key",
      model: "deepseek-v4-flash",
      runtimeFactory: () => new FailedProposalRuntime(),
      clock: () => 0,
    });

    const result = await node.run(createAgentInput({ task: "recover from a tool error" }));

    expect(result.status).toBe("completed");
    expect(result.spawnProposals).toEqual([]);
    expect(result.events.some((event) => event.type === "tool_rejected")).toBe(true);
    expect(verifyEventChain(result.events)).toBe(true);
  });
});

describe("Graph Agent Harness profile", () => {
  it("disables upstream shell/pty/resource capabilities and mounts only proposal MCP", () => {
    for (const id of [
      "sandbox",
      "sandbox-policy",
      "subprocess",
      "jobs",
      "pty",
      "terminal-bash",
      "terminal-pwsh",
      "persistent-bash",
      "persistent-pwsh",
      "mcp-resources",
    ]) {
      expect(GRAPH_AGENT_HARNESS_PATCH).toMatch(
        new RegExp(`- id: ${id}\\n  disabled: true`),
      );
    }
    expect(GRAPH_AGENT_HARNESS_PATCH).toContain("serverName: graph");
    expect(GRAPH_AGENT_HARNESS_PATCH).toContain("failOnStartupError: true");
    expect(GRAPH_AGENT_HARNESS_PATCH).not.toContain("danger-full-access");
  });
});
