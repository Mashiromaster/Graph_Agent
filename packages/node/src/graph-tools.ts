import type {
  MessageProposal,
  SkipContextProposal,
  SpawnProposal,
} from "@graph-agent/core";
import {
  canonicalJson,
  createMessageProposal,
  createSkipContextProposal,
  createSpawnProposal,
} from "@graph-agent/core";
import type { ToolDefinition } from "@graph-agent/adapter";
import { deriveId } from "@graph-agent/session";
import type { AgentSpec } from "./spec.js";

export const SPAWN_TOOL = "graph__propose_spawn";
export const MESSAGE_TOOL = "graph__send_message";
export const SKIP_CONTEXT_TOOL = "graph__request_skip_context";

export const GRAPH_TOOL_DEFINITIONS: readonly ToolDefinition[] = Object.freeze([
  Object.freeze({
    name: SPAWN_TOOL,
    description:
      "Propose spawning a child agent. The external graph controller must approve it.",
    inputSchema: Object.freeze({
      type: "object",
      additionalProperties: false,
      required: ["role", "objective", "instructions"],
      properties: {
        role: { type: "string" },
        objective: { type: "string" },
        instructions: { type: "string" },
        tool_names: { type: "array", items: { type: "string" } },
        priority: { type: "number", minimum: 0, maximum: 1 },
        budget_share: { type: "number", exclusiveMinimum: 0, maximum: 1 },
      },
    }),
  }),
  Object.freeze({
    name: MESSAGE_TOOL,
    description:
      "Propose sending a direct message to another node. The external graph controller must approve it.",
    inputSchema: Object.freeze({
      type: "object",
      additionalProperties: false,
      required: ["target_node_id", "content"],
      properties: {
        target_node_id: { type: "string" },
        content: { type: "string" },
        priority: { type: "number", minimum: 0, maximum: 1 },
        ttl_seconds: { type: "integer", minimum: 1 },
      },
    }),
  }),
  Object.freeze({
    name: SKIP_CONTEXT_TOOL,
    description:
      "Propose skipping context from a source node. The external graph controller must approve it.",
    inputSchema: Object.freeze({
      type: "object",
      additionalProperties: false,
      required: ["source_node_id", "reason"],
      properties: {
        source_node_id: { type: "string" },
        reason: { type: "string" },
        context_gate: { type: "number", minimum: 0, maximum: 1 },
      },
    }),
  }),
]);

/**
 * 按节点策略筛选可见的图工具。
 *
 * 为什么必须筛:`ProposalCollector` 在**分派**时才按
 * `allowDirectMessages`/`allowSkipContext`/`maxChildren`/`maxGeneration` 拒绝,
 * 但模型在**决策**时看到的是工具清单。若把三个工具一律advertise 出去,模型会
 * 对着不可用的能力规划、消耗 token 产生注定被拒的提案,而这些拒绝还会计入
 * 提案有效率(reward 信号之一),把策略配置的后果错记成模型的失误。
 *
 * 对实验更要紧的一点:A3(带权树)与 A5(动态图)的差别**就是**消息与跳连
 * 是否可用。若两臂看到的工具清单相同,臂的区分便不成立,§6 的消融也就无从归因。
 */
export function graphToolDefinitionsFor(spec: AgentSpec): ToolDefinition[] {
  // 编排层物化子节点时构造的 spec 是 `{identity, budget, role}`——**不带 policy**
  // (见 orchestrator/src/mutations.ts 的 applySpawn,及 orchestrator/src/runner.ts
  // 的 AgentSpec 定义,后者刻意不含 policy 以免 orchestrator 依赖 node)。
  // 因此此处必须容忍 policy 缺失,并退回 createAgentSpec 的同一套默认值,
  // 否则子节点会在构造期因读 undefined 而崩。
  const policy = spec.policy as AgentSpec["policy"] | undefined;
  const maxChildren = policy?.maxChildren ?? 8;
  const maxGeneration = policy?.maxGeneration ?? 4;
  const allowDirectMessages = policy?.allowDirectMessages ?? false;
  const allowSkipContext = policy?.allowSkipContext ?? false;

  const allowed: ToolDefinition[] = [];
  for (const definition of GRAPH_TOOL_DEFINITIONS) {
    if (definition.name === SPAWN_TOOL) {
      // maxChildren/maxGeneration 任一为 0 即无法派生,不必 advertise。
      if (maxChildren > 0 && maxGeneration > 0) {
        allowed.push(definition);
      }
      continue;
    }
    if (definition.name === MESSAGE_TOOL) {
      if (allowDirectMessages) {
        allowed.push(definition);
      }
      continue;
    }
    if (definition.name === SKIP_CONTEXT_TOOL) {
      if (allowSkipContext) {
        allowed.push(definition);
      }
      continue;
    }
    allowed.push(definition);
  }
  return allowed;
}

type Proposal = SpawnProposal | MessageProposal | SkipContextProposal;

export interface ProposalResult {
  readonly accepted: boolean;
  readonly output: string;
  readonly proposal?: Proposal;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function unit(value: unknown, label: string): number {
  if (typeof value !== "number" || typeof value === "boolean") {
    throw new Error(`${label} must be a number`);
  }
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be within [0, 1]`);
  }
  return value;
}

function positiveUnit(value: unknown, label: string): number {
  const n = unit(value, label);
  if (n <= 0) {
    throw new Error(`${label} must be within (0, 1]`);
  }
  return n;
}

export class ProposalCollector {
  readonly spawns: SpawnProposal[] = [];
  readonly messages: MessageProposal[] = [];
  readonly skipContexts: SkipContextProposal[] = [];

  private readonly spec: AgentSpec;
  private readonly availableToolNames: ReadonlySet<string>;

  constructor(input: { spec: AgentSpec; availableToolNames: ReadonlySet<string> }) {
    this.spec = input.spec;
    this.availableToolNames = input.availableToolNames;
  }

  invoke(name: string, args: Record<string, unknown>, ordinal: number): ProposalResult {
    let proposal: Proposal;
    try {
      if (name === SPAWN_TOOL) {
        proposal = this._spawn(args, ordinal);
        this.spawns.push(proposal);
      } else if (name === MESSAGE_TOOL) {
        proposal = this._message(args, ordinal);
        this.messages.push(proposal);
      } else if (name === SKIP_CONTEXT_TOOL) {
        proposal = this._skipContext(args, ordinal);
        this.skipContexts.push(proposal);
      } else {
        return {
          accepted: false,
          output: `Rejected unknown graph operation: ${name}`,
        };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { accepted: false, output: `Rejected graph proposal: ${message}` };
    }
    return {
      accepted: true,
      output: canonicalJson({
        status: "proposed",
        proposalId: proposal.proposalId,
        note: "The external graph controller must approve this proposal.",
      }),
      proposal,
    };
  }

  private _spawn(args: Record<string, unknown>, ordinal: number): SpawnProposal {
    const generation = this.spec.identity.generation + 1;
    if (generation > this.spec.policy.maxGeneration) {
      throw new Error(
        `generation ${generation} exceeds maxGeneration ${this.spec.policy.maxGeneration}`,
      );
    }
    if (this.spawns.length >= this.spec.policy.maxChildren) {
      throw new Error(`maxChildren ${this.spec.policy.maxChildren} reached`);
    }

    const rawToolNames = args.tool_names ?? [];
    if (!Array.isArray(rawToolNames)) {
      throw new Error("tool_names must be an array of strings");
    }
    const toolNames = rawToolNames.map((item, index) =>
      text(item, `tool_names[${index}]`),
    );
    for (const toolName of toolNames) {
      if (!this.availableToolNames.has(toolName)) {
        throw new Error("unavailable tools requested");
      }
    }

    const priority = unit(args.priority ?? 0.5, "priority");
    const budgetShare = positiveUnit(args.budget_share ?? 0.25, "budget_share");
    const existing = this.spawns.reduce((sum, s) => sum + s.budgetShare, 0);
    if (existing + budgetShare > 1) {
      throw new Error("cumulative budget_share exceeds 1");
    }

    return createSpawnProposal({
      proposalId: deriveId(this.spec.identity.nodeId, "spawn", ordinal),
      parentNodeId: this.spec.identity.nodeId,
      generation,
      role: text(args.role, "role"),
      objective: text(args.objective, "objective"),
      instructions: text(args.instructions, "instructions"),
      toolNames,
      priority,
      budgetShare,
    });
  }

  private _message(args: Record<string, unknown>, ordinal: number): MessageProposal {
    if (!this.spec.policy.allowDirectMessages) {
      throw new Error("direct messages are not allowed by policy");
    }
    const target = text(args.target_node_id, "target_node_id");
    if (target === this.spec.identity.nodeId) {
      throw new Error("cannot send a message to self");
    }
    const priority = unit(args.priority ?? 0.5, "priority");
    const ttl = args.ttl_seconds ?? 300;
    if (typeof ttl !== "number" || typeof ttl === "boolean" || !Number.isInteger(ttl)) {
      throw new Error("ttl_seconds must be an integer");
    }
    if (ttl < 1) {
      throw new Error("ttl_seconds must be >= 1");
    }
    return createMessageProposal({
      proposalId: deriveId(this.spec.identity.nodeId, "message", ordinal),
      sourceNodeId: this.spec.identity.nodeId,
      targetNodeId: target,
      content: text(args.content, "content"),
      priority,
      ttlSeconds: ttl,
    });
  }

  private _skipContext(
    args: Record<string, unknown>,
    ordinal: number,
  ): SkipContextProposal {
    if (!this.spec.policy.allowSkipContext) {
      throw new Error("skip-context is not allowed by policy");
    }
    const source = text(args.source_node_id, "source_node_id");
    if (source === this.spec.identity.nodeId) {
      throw new Error("cannot skip context from self");
    }
    const contextGate = unit(args.context_gate ?? 0.5, "context_gate");
    return createSkipContextProposal({
      proposalId: deriveId(this.spec.identity.nodeId, "skip", ordinal),
      requesterNodeId: this.spec.identity.nodeId,
      sourceNodeId: source,
      reason: text(args.reason, "reason"),
      contextGate,
    });
  }
}
