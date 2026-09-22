/**
 * Stdio MCP server mounted inside a DeepSeek Harness node process.
 *
 * It deliberately exposes proposal-only operations. The server performs the
 * node-local validation so the model gets immediate feedback, while the parent
 * process independently replays every call and GraphController remains the
 * sole graph writer.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { canonicalJson } from "@graph-agent/core";
import {
  MESSAGE_TOOL,
  ProposalCollector,
  SKIP_CONTEXT_TOOL,
  SPAWN_TOOL,
  agentSpecFromDict,
} from "@graph-agent/node";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function parseStringArray(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error("GRAPH_AGENT_ALLOWED_TOOLS_JSON must be a string array");
  }
  return parsed;
}

const spec = agentSpecFromDict(JSON.parse(requiredEnv("GRAPH_AGENT_SPEC_JSON")) as unknown);
const allowedTools = parseStringArray(requiredEnv("GRAPH_AGENT_ALLOWED_TOOLS_JSON"));
const collector = new ProposalCollector({
  spec,
  availableToolNames: new Set(allowedTools),
});

let ordinal = 0;
let toolCalls = 0;

function toolResult(name: string, args: Record<string, unknown>) {
  toolCalls += 1;
  if (toolCalls > spec.budget.maxToolCalls) {
    return {
      content: [
        {
          type: "text" as const,
          text: canonicalJson({
            status: "rejected",
            summary: `Tool-call budget ${spec.budget.maxToolCalls} exhausted.`,
            next_actions: ["Finish the answer without another tool call."],
            artifacts: [],
          }),
        },
      ],
    };
  }

  const result = collector.invoke(name, args, ordinal++);
  return {
    content: [
      {
        type: "text" as const,
        text: canonicalJson({
          status: result.accepted ? "proposed" : "rejected",
          summary: result.output,
          next_actions: result.accepted
            ? ["Continue reasoning; the external GraphController will decide the proposal."]
            : ["Correct the arguments or finish without this proposal."],
          artifacts:
            result.proposal === undefined
              ? []
              : [{ kind: "graph_proposal", proposal_id: result.proposal.proposalId }],
        }),
      },
    ],
  };
}

const server = new McpServer(
  { name: "graph-agent-proposals", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

const safeAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

server.registerTool(
  "propose_spawn",
  {
    description:
      "Propose a child Agent to the external GraphController. This never creates the child directly.",
    inputSchema: {
      role: z.string().min(1),
      objective: z.string().min(1),
      instructions: z.string().min(1),
      tool_names: z.array(z.string().min(1)).optional(),
      priority: z.number().min(0).max(1).optional(),
      budget_share: z.number().positive().max(1).optional(),
    },
    annotations: safeAnnotations,
  },
  async (args) => toolResult(SPAWN_TOOL, args),
);

server.registerTool(
  "send_message",
  {
    description:
      "Propose a direct message to another graph node. The external GraphController must approve it.",
    inputSchema: {
      target_node_id: z.string().min(1),
      content: z.string().min(1),
      priority: z.number().min(0).max(1).optional(),
      ttl_seconds: z.number().int().min(1).optional(),
    },
    annotations: safeAnnotations,
  },
  async (args) => toolResult(MESSAGE_TOOL, args),
);

server.registerTool(
  "request_skip_context",
  {
    description:
      "Propose excluding context from one source node. The external GraphController must approve it.",
    inputSchema: {
      source_node_id: z.string().min(1),
      reason: z.string().min(1),
      context_gate: z.number().min(0).max(1).optional(),
    },
    annotations: safeAnnotations,
  },
  async (args) => toolResult(SKIP_CONTEXT_TOOL, args),
);

const transport = new StdioServerTransport();
await server.connect(transport);
