#!/usr/bin/env node
/**
 * @graph-agent/cli — the top of the TypeScript stack.
 *
 * A thin, dependency-free (beyond the graph-agent workspaces) command surface:
 *   graph-agent demo             offline single-node AgentNode demo
 *   graph-agent controller-demo  offline GraphController spawn→converge demo
 *   graph-agent ui [flags]       launch the Web Studio HTTP server
 *
 * Determinism: the two demos are fully offline (ScriptedModel, clock=() => 0);
 * no Date.now / Math.random / network. `main` returns an exit code and takes an
 * injectable line writer + optional serve override so tests capture output and
 * never bind a socket.
 */

import { pathToFileURL } from "node:url";
import {
  createAgentIdentity,
  createAgentInput,
  createNodeBudget,
  verifyEventChain,
} from "@graph-agent/core";
import {
  createModelResponse,
  createToolCall,
  ScriptedModel,
} from "@graph-agent/adapter";
import {
  AgentNode,
  FunctionTool,
  createAgentSpec,
  type AgentSpec as NodeAgentSpec,
} from "@graph-agent/node";
import {
  GraphController,
  createControllerPolicy,
  runSnapshotToDict,
  verifyControllerEventChain,
  RunStatus,
  type AgentSpec as OrchestratorAgentSpec,
  type NodeFactory,
  type NodeRunner,
} from "@graph-agent/orchestrator";
import { serve as realServe } from "@graph-agent/web";

const USAGE = [
  "Usage: graph-agent <command> [options]",
  "",
  "Commands:",
  "  demo               Run an offline single-node agent demo.",
  "  controller-demo    Run an offline graph-controller spawn demo.",
  "  ui [--host H] [--port P] [--no-browser]   Launch the Web Studio server.",
].join("\n");

interface CliDeps {
  serve?: typeof realServe;
}

/** Build the offline `demo` payload and return the exit code. */
async function runDemo(out: (line: string) => void): Promise<number> {
  const spec = createAgentSpec({
    identity: createAgentIdentity({
      nodeId: "demo",
      name: "Demo Agent",
      role: "demo",
      generation: 0,
    }),
    instructions: "You are a demo agent.",
    budget: createNodeBudget({
      maxTurns: 4,
      maxToolCalls: 4,
      maxTotalTokens: 2000,
      timeoutSeconds: 30,
    }),
    policy: {
      maxGeneration: 1,
      maxChildren: 1,
      allowDirectMessages: false,
      allowSkipContext: false,
    },
  });

  const multiply = new FunctionTool({
    name: "multiply",
    description: "Multiply two integers",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["a", "b"],
      properties: { a: { type: "integer" }, b: { type: "integer" } },
    },
    fn: ({ a, b }) => String(Number(a) * Number(b)),
  });

  const model = new ScriptedModel([
    createModelResponse({
      content: null,
      toolCalls: [
        createToolCall({ id: "c1", name: "multiply", arguments: { a: 6, b: 7 } }),
      ],
    }),
    createModelResponse({ content: "The answer is 42." }),
  ]);

  const node = new AgentNode({ spec, model, tools: [multiply] });
  const result = await node.run(createAgentInput({ task: "What is 6 times 7?" }));

  const payload = {
    node_id: result.nodeId,
    status: result.status,
    output: result.output,
    usage: result.usage,
    spawn_proposals: result.spawnProposals.length,
    event_count: result.events.length,
    event_chain_valid: verifyEventChain(result.events),
    error: result.error,
  };
  out(JSON.stringify(payload, null, 2));
  return result.error ? 1 : 0;
}

/**
 * Factory for the controller demo. Both root and child are AgentNodes backed by
 * ScriptedModels chosen by role: the root proposes exactly one "reviewer" child
 * then completes; the child completes immediately with no proposals.
 */
const DEMO_ROLE_ROOT = "coordinator";
const DEMO_ROLE_CHILD = "reviewer";

function rootScript(): ScriptedModel {
  return new ScriptedModel([
    createModelResponse({
      content: null,
      toolCalls: [
        createToolCall({
          id: "spawn-1",
          name: "graph__propose_spawn",
          arguments: {
            role: DEMO_ROLE_CHILD,
            objective: "Review the coordinator's plan.",
            instructions: "Read the plan and report whether it is sound.",
            budget_share: 0.5,
          },
        }),
      ],
    }),
    createModelResponse({ content: "Delegated review to a child agent." }),
  ]);
}

function childScript(): ScriptedModel {
  return new ScriptedModel([createModelResponse({ content: "Review complete." })]);
}

/**
 * Promote an orchestrator AgentSpec (identity + budget + role) to a rich node
 * AgentSpec with a policy permissive enough for the root to spawn one child.
 */
function toNodeSpec(spec: OrchestratorAgentSpec): NodeAgentSpec {
  return createAgentSpec({
    identity: spec.identity,
    budget: spec.budget,
    instructions: `You are the ${spec.role ?? spec.identity.role}.`,
    ...(spec.role !== undefined ? { role: spec.role } : {}),
    policy: {
      maxGeneration: 2,
      maxChildren: 1,
      allowDirectMessages: false,
      allowSkipContext: false,
    },
  });
}

const demoFactory: NodeFactory = {
  create({ spec }): NodeRunner {
    const nodeSpec = toNodeSpec(spec);
    const isRoot = spec.identity.generation === 0;
    const model = isRoot ? rootScript() : childScript();
    return new AgentNode({ spec: nodeSpec, model });
  },
};

/** Build the offline `controller-demo` payload and return the exit code. */
async function runControllerDemo(out: (line: string) => void): Promise<number> {
  const controller = new GraphController(
    demoFactory,
    createControllerPolicy({
      maxNodes: 4,
      maxEdges: 8,
      maxGeneration: 2,
      maxChildrenPerNode: 2,
      maxTotalTokens: 16000,
      maxConcurrency: 2,
    }),
  );

  const rootSpec: OrchestratorAgentSpec = {
    identity: createAgentIdentity({
      nodeId: "root",
      name: "Coordinator Agent",
      role: DEMO_ROLE_ROOT,
      generation: 0,
    }),
    budget: createNodeBudget({
      maxTurns: 4,
      maxToolCalls: 4,
      maxTotalTokens: 8000,
      timeoutSeconds: 30,
    }),
    role: DEMO_ROLE_ROOT,
  };
  const rootRunner = demoFactory.create({ spec: rootSpec, toolNames: [] });
  const rootInput = createAgentInput({ task: "Coordinate a small review." });

  await controller.createRun("demo-run", rootSpec, rootRunner, rootInput);
  const snapshot = await controller.runUntilIdle("demo-run");

  out(
    JSON.stringify(
      {
        snapshot: runSnapshotToDict(snapshot),
        controller_event_chain_valid: verifyControllerEventChain(
          controller.events("demo-run"),
        ),
      },
      null,
      2,
    ),
  );
  return snapshot.status === RunStatus.SUCCEEDED ? 0 : 1;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

interface UiFlags {
  host: string;
  port: number;
  noBrowser: boolean;
}

type UiParse = { ok: true; flags: UiFlags } | { ok: false; error: string };

/** Minimal, dependency-free flag parsing for the `ui` command. */
function parseUiFlags(argv: readonly string[]): UiParse {
  let host = "127.0.0.1";
  let port = 8765;
  let noBrowser = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--no-browser") {
      noBrowser = true;
      continue;
    }
    if (arg === "--host") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ok: false, error: "--host requires a value" };
      }
      host = value;
      i += 1;
      continue;
    }
    if (arg === "--port") {
      const value = argv[i + 1];
      if (value === undefined) {
        return { ok: false, error: "--port requires a value" };
      }
      port = Number(value);
      i += 1;
      continue;
    }
    return { ok: false, error: `unknown option: ${arg}` };
  }

  if (!LOOPBACK_HOSTS.has(host)) {
    return { ok: false, error: `--host must be one of 127.0.0.1|localhost, got ${host}` };
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    return { ok: false, error: `--port must be an integer in 0..65535, got ${port}` };
  }
  return { ok: true, flags: { host, port, noBrowser } };
}

/** Parse flags, launch the (possibly injected) server, return the exit code. */
function runUi(
  argv: readonly string[],
  out: (line: string) => void,
  serve: typeof realServe,
): number {
  const parsed = parseUiFlags(argv);
  if (!parsed.ok) {
    out(`Error: ${parsed.error}`);
    return 2;
  }
  const { host, port, noBrowser } = parsed.flags;
  serve(host, port, { openBrowser: !noBrowser });
  out(`Graph Agent Studio listening on http://${host}:${port}`);
  return 0;
}

export async function main(
  argv: readonly string[],
  out: (line: string) => void = console.log,
  deps?: CliDeps,
): Promise<number> {
  const command = argv[0];
  const rest = argv.slice(1);
  switch (command) {
    case "demo":
      return runDemo(out);
    case "controller-demo":
      return runControllerDemo(out);
    case "ui":
      return runUi(rest, out, deps?.serve ?? realServe);
    default:
      out(USAGE);
      return 2;
  }
}

// ESM main-module guard: only auto-run when executed directly, never on import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main(process.argv.slice(2)).then((code) => process.exit(code));
}
