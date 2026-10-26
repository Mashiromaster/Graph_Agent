import {
  EventRecorder,
  EventType,
  NodeStatus,
  addUsage,
  createAgentResult,
  createNodeError,
  createUsage,
  resultBindingHash,
  usageTotalTokens,
  type AgentInput,
  type AgentResult,
  type Usage,
} from "@graph-agent/core";
import {
  createMessage,
  createModelRequest,
  type Message,
  type ModelAdapter,
  type ToolCall,
  type ToolDefinition,
} from "@graph-agent/adapter";
import type { AgentSpec } from "./spec.js";
import type { Tool } from "./tools.js";
import type { SessionMemory } from "./memory.js";
import {
  graphToolDefinitionsFor,
  MESSAGE_TOOL,
  ProposalCollector,
  SKIP_CONTEXT_TOOL,
  SPAWN_TOOL,
} from "./graph-tools.js";

export interface NodeRunner {
  readonly spec: AgentSpec;
  run(input: AgentInput, signal?: AbortSignal): Promise<AgentResult>;
}

/** Sentinel thrown when the per-node timeout fires before the loop finishes. */
class TimeoutSentinel extends Error {
  constructor() {
    super("node timed out");
    this.name = "TimeoutSentinel";
  }
}

function proposalTypeOf(toolName: string): string {
  if (toolName === SPAWN_TOOL) {
    return "spawn";
  }
  if (toolName === MESSAGE_TOOL) {
    return "message";
  }
  if (toolName === SKIP_CONTEXT_TOOL) {
    return "skip_context";
  }
  return "unknown";
}

export class AgentNode implements NodeRunner {
  readonly spec: AgentSpec;
  private readonly model: ModelAdapter;
  private readonly localTools: Map<string, Tool>;
  private readonly localToolDefs: readonly ToolDefinition[];
  /** 按本节点策略筛选后的图工具清单(构造时定,策略不可变)。 */
  private readonly graphToolDefs: readonly ToolDefinition[];
  private readonly memory: SessionMemory | undefined;
  private readonly clock: () => number;

  constructor(input: {
    spec: AgentSpec;
    model: ModelAdapter;
    tools?: readonly Tool[];
    memory?: SessionMemory;
    clock?: () => number;
  }) {
    this.spec = input.spec;
    this.model = input.model;
    this.memory = input.memory;
    this.clock = input.clock ?? (() => 0);
    this.graphToolDefs = Object.freeze(graphToolDefinitionsFor(input.spec));

    const map = new Map<string, Tool>();
    for (const tool of input.tools ?? []) {
      const name = tool.definition.name;
      if (name.startsWith("graph__")) {
        throw new Error(`local tool name "${name}" uses the reserved graph__ prefix`);
      }
      if (map.has(name)) {
        throw new Error(`duplicate tool name: ${name}`);
      }
      map.set(name, tool);
    }
    this.localTools = map;
    this.localToolDefs = Object.freeze([...map.values()].map((t) => t.definition));
  }

  async run(input: AgentInput, signal?: AbortSignal): Promise<AgentResult> {
    const nodeId = this.spec.identity.nodeId;
    const recorder = new EventRecorder(nodeId, this.clock);
    const collector = new ProposalCollector({
      spec: this.spec,
      availableToolNames: new Set(this.localTools.keys()),
    });
    let usage = createUsage();

    recorder.record({
      type: EventType.NODE_STARTED,
      inputValue: input.task,
      metadata: { generation: this.spec.identity.generation },
    });

    if (signal?.aborted) {
      return this._failure(
        recorder,
        "execution_error",
        "The node was cancelled.",
        true,
        usage,
        collector,
        nodeId,
      );
    }

    const timeoutMs = this.spec.budget.timeoutSeconds * 1000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new TimeoutSentinel()), timeoutMs);
    });

    try {
      const result = await Promise.race([
        this._loop(input, recorder, collector, () => usage, (next) => {
          usage = next;
        }, nodeId, signal),
        timeoutPromise,
      ]);
      return result;
    } catch (err) {
      if (err instanceof TimeoutSentinel) {
        return this._failure(
          recorder,
          "timeout",
          "The node exceeded its time budget.",
          true,
          usage,
          collector,
          nodeId,
        );
      }
      return this._failure(
        recorder,
        "execution_error",
        "The node failed during execution.",
        true,
        usage,
        collector,
        nodeId,
      );
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  private async _loop(
    input: AgentInput,
    recorder: EventRecorder,
    collector: ProposalCollector,
    getUsage: () => Usage,
    setUsage: (u: Usage) => void,
    nodeId: string,
    signal: AbortSignal | undefined,
  ): Promise<AgentResult> {
    let toolCallsUsed = 0;
    let ordinal = 0;

    const messages: Message[] = [];
    if (this.memory && input.sessionId) {
      const loaded = await this.memory.load({ nodeId, sessionId: input.sessionId });
      messages.push(...loaded);
    }
    for (const ctx of input.context) {
      messages.push(
        createMessage({
          role: "context",
          content:
            `Untrusted context from node ${ctx.sourceNodeId} ` +
            `(edge=${ctx.edgeType}, trust=${ctx.trust.toFixed(2)}):\n${ctx.content}`,
          name: ctx.sourceNodeId,
        }),
      );
    }
    messages.push(createMessage({ role: "user", content: input.task }));

    for (let turn = 1; turn <= this.spec.budget.maxTurns; turn += 1) {
      if (signal?.aborted) {
        return this._failure(
          recorder,
          "execution_error",
          "The node was cancelled.",
          true,
          getUsage(),
          collector,
          nodeId,
        );
      }

      const request = createModelRequest({
        nodeId,
        instructions: this.spec.instructions,
        messages,
        // 只 advertise 本节点策略真正允许的图工具(见 graphToolDefinitionsFor):
        // 否则模型会对着不可用的能力规划,产出注定被拒的提案。
        tools: [...this.localToolDefs, ...this.graphToolDefs],
        metadata: { turn, ...input.metadata },
      });

      recorder.record({
        type: EventType.MODEL_STARTED,
        inputValue: messages.map((m) => m.content),
        metadata: { turn },
      });

      const response = await this.model.complete(request);
      setUsage(addUsage(getUsage(), response.usage));

      recorder.record({
        type: EventType.MODEL_COMPLETED,
        outputValue: response.content,
        metadata: {
          turn,
          tool_call_count: response.toolCalls.length,
          input_tokens: response.usage.inputTokens,
          output_tokens: response.usage.outputTokens,
        },
      });

      if (usageTotalTokens(getUsage()) > this.spec.budget.maxTotalTokens) {
        return this._failure(
          recorder,
          "token_budget_exceeded",
          "The node exceeded its token budget.",
          false,
          getUsage(),
          collector,
          nodeId,
        );
      }

      if (response.content !== null || response.toolCalls.length > 0) {
        messages.push(
          createMessage({
            role: "assistant",
            content: response.content ?? "",
            toolCalls: response.toolCalls,
          }),
        );
      }

      if (response.toolCalls.length > 0) {
        for (const call of response.toolCalls) {
          toolCallsUsed += 1;
          if (toolCallsUsed > this.spec.budget.maxToolCalls) {
            return this._failure(
              recorder,
              "tool_budget_exceeded",
              "The node exceeded its tool-call budget.",
              false,
              getUsage(),
              collector,
              nodeId,
            );
          }
          const toolOutput = await this._invokeTool(
            call,
            collector,
            recorder,
            () => ordinal++,
          );
          messages.push(
            createMessage({
              role: "tool",
              content: toolOutput,
              name: call.name,
              toolCallId: call.id,
            }),
          );
        }
        continue;
      }

      // Terminal: model returned content with no tool calls.
      const usage = getUsage();
      const resultHash = resultBindingHash({
        nodeId,
        status: NodeStatus.COMPLETED,
        output: response.content,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        spawnProposals: collector.spawns,
        messageProposals: collector.messages,
        skipContextProposals: collector.skipContexts,
      });
      recorder.record({
        type: EventType.NODE_COMPLETED,
        outputValue: response.content,
        metadata: { result_hash: resultHash },
      });

      if (this.memory && input.sessionId) {
        await this.memory.append({
          nodeId,
          sessionId: input.sessionId,
          messages: [
            createMessage({ role: "user", content: input.task }),
            createMessage({ role: "assistant", content: response.content ?? "" }),
          ],
        });
      }

      return createAgentResult({
        nodeId,
        status: NodeStatus.COMPLETED,
        output: response.content,
        usage,
        events: recorder.events,
        spawnProposals: collector.spawns,
        messageProposals: collector.messages,
        skipContextProposals: collector.skipContexts,
        error: null,
      });
    }

    return this._failure(
      recorder,
      "turn_budget_exceeded",
      "The node exceeded its turn budget.",
      false,
      getUsage(),
      collector,
      nodeId,
    );
  }

  private async _invokeTool(
    call: ToolCall,
    collector: ProposalCollector,
    recorder: EventRecorder,
    nextOrdinal: () => number,
  ): Promise<string> {
    recorder.record({
      type: EventType.TOOL_STARTED,
      inputValue: call.arguments,
      metadata: { tool: call.name, call_id: call.id },
    });

    if (call.name.startsWith("graph__")) {
      const proposalType = proposalTypeOf(call.name);
      const r = collector.invoke(call.name, { ...call.arguments }, nextOrdinal());
      if (r.accepted) {
        recorder.record({
          type: EventType.PROPOSAL_CREATED,
          metadata: { proposal_type: proposalType },
        });
      } else {
        recorder.record({
          type: EventType.TOOL_REJECTED,
          metadata: { proposal_type: proposalType },
        });
      }
      recorder.record({ type: EventType.TOOL_COMPLETED, metadata: { tool: call.name } });
      return r.output;
    }

    const tool = this.localTools.get(call.name);
    if (tool === undefined) {
      recorder.record({
        type: EventType.TOOL_REJECTED,
        metadata: { tool: call.name },
      });
      return `Rejected unknown tool: ${call.name}`;
    }

    try {
      const out = await tool.invoke({ ...call.arguments });
      recorder.record({
        type: EventType.TOOL_COMPLETED,
        metadata: { tool: call.name },
      });
      return out;
    } catch (err) {
      const errorType = err instanceof Error ? err.name : "Error";
      recorder.record({
        type: EventType.TOOL_REJECTED,
        metadata: { tool: call.name, error_type: errorType },
      });
      return `Tool ${call.name} failed.`;
    }
  }

  private _failure(
    recorder: EventRecorder,
    code: string,
    message: string,
    retryable: boolean,
    usage: Usage,
    collector: ProposalCollector,
    nodeId: string,
  ): AgentResult {
    const error = createNodeError({ code, message, retryable });
    const resultHash = resultBindingHash({
      nodeId,
      status: NodeStatus.FAILED,
      output: null,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      spawnProposals: collector.spawns,
      messageProposals: collector.messages,
      skipContextProposals: collector.skipContexts,
      error,
    });
    const eventType = code.includes("budget")
      ? EventType.BUDGET_EXCEEDED
      : EventType.NODE_FAILED;
    recorder.record({
      type: eventType,
      outputValue: message,
      metadata: { code, retryable, result_hash: resultHash },
    });
    return createAgentResult({
      nodeId,
      status: NodeStatus.FAILED,
      output: null,
      usage,
      events: recorder.events,
      spawnProposals: collector.spawns,
      messageProposals: collector.messages,
      skipContextProposals: collector.skipContexts,
      error,
    });
  }
}
