/**
 * A fail-closed overlay for DeepSeek Harness' `sdk-minimal` profile.
 *
 * The upstream profile is intentionally useful for coding agents and therefore
 * includes a persistent shell running with danger-full-access. Graph Agent is
 * a conversation orchestrator, so this overlay removes that entire capability
 * plane and inserts one local MCP server that can only submit graph proposals.
 * Values that vary per node are supplied through the scrubbed child environment.
 */
export const GRAPH_AGENT_HARNESS_PATCH = `
- id: sandbox
  disabled: true

- id: sandbox-policy
  disabled: true

- id: subprocess
  disabled: true

- id: jobs
  disabled: true

- id: pty
  disabled: true

- id: terminal-bash
  disabled: true

- id: terminal-pwsh
  disabled: true

- id: persistent-bash
  disabled: true

- id: persistent-pwsh
  disabled: true

- id: mcp-resources
  disabled: true

- insert:
    - id: graph-agent-proposals
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: graph
        transport: stdio
        command: !!js process.execPath
        args:
          - !!js process.env.GRAPH_AGENT_MCP_SERVER
        env:
          GRAPH_AGENT_SPEC_JSON: !!js process.env.GRAPH_AGENT_SPEC_JSON
          GRAPH_AGENT_ALLOWED_TOOLS_JSON: !!js process.env.GRAPH_AGENT_ALLOWED_TOOLS_JSON
        cwd: !!js process.cwd()
        toolCallTimeoutMs: !!js Number(process.env.GRAPH_AGENT_TOOL_TIMEOUT_MS ?? 60000)
        failOnStartupError: true
        reconnect:
          enabled: false
          initialDelayMs: 100
          maxDelayMs: 100
          maxAttempts: 1
`;
