import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DeepSeekHarness } from "@deepseek-ai/dsh-sdk-client";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { GRAPH_AGENT_HARNESS_PATCH } from "@graph-agent/harness";

const spec = {
  identity: {
    nodeId: "smoke-root",
    name: "Smoke Root",
    role: "orchestrator",
    generation: 0,
    parentNodeId: null,
    trustScore: 1,
  },
  budget: {
    maxTurns: 2,
    maxToolCalls: 3,
    maxTotalTokens: 1_000,
    timeoutSeconds: 20,
  },
  instructions: "SDK startup smoke only.",
  role: "orchestrator",
  policy: {
    maxGeneration: 2,
    maxChildren: 2,
    allowDirectMessages: false,
    allowSkipContext: false,
  },
};

const mcpServer = resolve("packages/harness/dist/mcp-server.js");
const specJson = JSON.stringify(spec);

function safeEnvironment(extra) {
  const env = {};
  for (const key of [
    "PATH",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "TMPDIR",
    "TEMP",
    "TMP",
    "SystemRoot",
    "COMSPEC",
    "PATHEXT",
  ]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, ...extra };
}

async function smokeMcp() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpServer],
    cwd: process.cwd(),
    env: safeEnvironment({
      GRAPH_AGENT_SPEC_JSON: specJson,
      GRAPH_AGENT_ALLOWED_TOOLS_JSON: "[]",
    }),
  });
  const client = new Client({ name: "graph-agent-smoke", version: "1.0.0" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    const expected = ["propose_spawn", "request_skip_context", "send_message"];
    if (JSON.stringify(names) !== JSON.stringify(expected)) {
      throw new Error(`unexpected Graph MCP tools: ${JSON.stringify(names)}`);
    }
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function smokeHarness() {
  const home = await mkdtemp(join(tmpdir(), "graph-agent-harness-smoke-"));
  let harness;
  try {
    const patch = join(home, "graph-agent.cordis.patch.yml");
    await writeFile(patch, GRAPH_AGENT_HARNESS_PATCH, { encoding: "utf8", mode: 0o600 });
    harness = new DeepSeekHarness({
      profile: "sdk-minimal",
      patches: [patch],
      dshHome: home,
      processCwd: process.cwd(),
      cwd: process.cwd(),
      provider: "deepseek-official",
      model: "deepseek-v4-flash",
      maxTokens: 1_000,
      initializeTimeoutMs: 20_000,
      env: safeEnvironment({
        DEEPSEEK_API_KEY: "sk-placeholder-not-used-by-startup-smoke",
        DSH_SYSTEM_PROMPT: "Graph Agent startup smoke.",
        DSH_TELEMETRY_DISABLED: "1",
        GRAPH_AGENT_MCP_SERVER: mcpServer,
        GRAPH_AGENT_SPEC_JSON: specJson,
        GRAPH_AGENT_ALLOWED_TOOLS_JSON: "[]",
        GRAPH_AGENT_TOOL_TIMEOUT_MS: "10000",
      }),
    });
    await harness.start();
  } finally {
    await harness?.close().catch(() => undefined);
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  }
}

await smokeMcp();
await smokeHarness();
process.stdout.write("DeepSeek Harness smoke: OK\n");
