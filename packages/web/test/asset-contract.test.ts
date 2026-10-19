/**
 * Guards the wire contract between the TS serializers and the vanilla frontend.
 *
 * The frontend is plain JS, so a renamed field is not a compile error — it
 * silently reads `undefined`. That is exactly how the token metric rendered
 * "NaN tokens" and the graph failed to draw edges: `app.js` read snake_case
 * (`committed_tokens`, `source_node_id`) while runSnapshotToDict emits
 * camelCase.
 *
 * The casing split is deliberate and worth stating plainly:
 *   - StudioResult's OWN fields are snake_case (node_results, elapsed_ms, ...)
 *   - everything nested inside `snapshot` and `usage` is camelCase
 *
 * These tests read the shipped asset and assert it never reaches for a
 * camelCase field using snake_case.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createNodeRecord, runSnapshotToDict } from "@graph-agent/orchestrator";

const appJs = readFileSync(
  fileURLToPath(new URL("../assets/app.js", import.meta.url)),
  "utf8",
);

/** Fields that live inside snapshot/usage and are therefore camelCase. */
const CAMEL_NESTED = [
  "committed_tokens",
  "reserved_tokens",
  "limit_tokens",
  "allocation_tokens",
  "allowed_tool_names",
  "source_node_id",
  "target_node_id",
  "parent_node_id",
  "run_id",
  "edge_id",
  "content_hash",
  "ttl_seconds",
  "input_tokens",
  "output_tokens",
  "pending_executions",
];

describe("app.js wire contract", () => {
  it("never reads a nested snapshot/usage field as snake_case", () => {
    const offenders = CAMEL_NESTED.filter((field) =>
      new RegExp(`\\.${field}\\b`).test(appJs),
    );
    expect(offenders).toEqual([]);
  });

  it("reads the nested fields it needs in camelCase", () => {
    for (const expr of [
      "budget.committedTokens",
      "node.nodeId",
      "node.allowedToolNames",
      "node.allocationTokens",
      "edge.sourceNodeId",
      "edge.targetNodeId",
      "snapshot.runId",
    ]) {
      expect(appJs).toContain(expr);
    }
  });

  it("still reads StudioResult's own fields as snake_case", () => {
    // These are genuinely snake_case on the wire; don't "fix" them.
    for (const expr of ["node_results", "elapsed_ms", "primary_output", "event_count"]) {
      expect(appJs).toContain(expr);
    }
  });
});

describe("runSnapshotToDict casing", () => {
  it("emits camelCase keys the frontend expects", () => {
    const node = createNodeRecord({
      nodeId: "root",
      name: "Orchestrator",
      role: "orchestrator",
      parentNodeId: null,
      generation: 0,
      priority: 0.5,
      state: "succeeded",
      allowedToolNames: [],
      allocationTokens: 12000,
    });
    const dict = runSnapshotToDict({
      runId: "run-1",
      status: "succeeded",
      superstep: 1,
      nodes: [node],
      edges: [],
      executions: [],
      decisions: [],
      pendingExecutions: 0,
      budget: { limitTokens: 32000, committedTokens: 129, reservedTokens: 0 },
    });

    expect(Object.keys(dict)).toContain("runId");
    expect(Object.keys(dict.budget as object)).toEqual([
      "limitTokens",
      "committedTokens",
      "reservedTokens",
    ]);
    const serializedNode = (dict.nodes as Record<string, unknown>[])[0]!;
    expect(Object.keys(serializedNode)).toContain("nodeId");
    expect(Object.keys(serializedNode)).toContain("allocationTokens");
    expect(Object.keys(serializedNode)).toContain("allowedToolNames");
    // The bug shape: a snake_case key must never appear.
    expect(Object.keys(serializedNode).some((k) => k.includes("_"))).toBe(false);
  });
});
