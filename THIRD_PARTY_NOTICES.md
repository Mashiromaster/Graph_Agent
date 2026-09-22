# Third-party notices

## awesome-llm-apps

- Upstream: <https://github.com/Shubhamsaboo/awesome-llm-apps>
- Snapshot branch: `main`
- Upstream commit: `3d532f66e525ef440ddde24c001fdb82e9b2bf04`
- Commit timestamp: `2026-08-10T07:26:17Z`
- License: Apache License 2.0
- Local snapshot: `awesome-llm-apps/`
- Upstream license copy: `awesome-llm-apps/LICENSE`

The snapshot is retained as a reference corpus. The new `src/graph_agent/` implementation is an independent, framework-neutral design informed by the upstream project's public examples of lightweight agents, context/session management, agents-as-tools, parallel orchestration, routing, and trust-gated audit patterns. No upstream application is imported at runtime.

Individual examples in the upstream repository may integrate other libraries and services. Their respective licenses and terms remain applicable when those examples or dependencies are used directly.

## DeepSeek Harness

- Upstream: <https://github.com/deepseek-ai/deepseek-harness>
- Runtime integration: `@deepseek-ai/dsh-sdk-client@0.1.5-rc.3` (with the same-version `@deepseek-ai/dsh`)
- License: MIT
- Copyright: DeepSeek, 2026

The Studio uses the official TypeScript SDK to launch an isolated Harness runtime for each graph node. Graph Agent supplies its own restrictive profile overlay and proposal-only MCP server; it does not copy or vendor the upstream source tree. DeepSeek Harness is currently marked Developer Preview upstream, so its runtime/profile protocol is pinned and must be revalidated before upgrades.
