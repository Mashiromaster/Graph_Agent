import { resultBindingHash, type AgentResult } from "@graph-agent/core";

/**
 * Return the `result_hash` recorded in the terminal event's metadata, or null
 * when there are no events or no such key. Core's node writer binds a result
 * to its event chain by writing this key into the last event's metadata.
 */
export function terminalResultHash(result: AgentResult): string | null {
  const terminal = result.events[result.events.length - 1];
  if (terminal === undefined) {
    return null;
  }
  let metadata: Record<string, unknown>;
  try {
    metadata = JSON.parse(terminal.metadataJson) as Record<string, unknown>;
  } catch {
    return null;
  }
  const hash = metadata["result_hash"];
  return typeof hash === "string" ? hash : null;
}

/**
 * Recompute the canonical result-binding hash over the result's fields and
 * compare it to the hash bound into the terminal event. Returns false (never
 * throws) on any mismatch or missing hash — fail-closed verification.
 */
export function verifyResultBinding(result: AgentResult): boolean {
  const bound = terminalResultHash(result);
  if (bound === null) {
    return false;
  }
  const recomputed = resultBindingHash({
    nodeId: result.nodeId,
    status: result.status,
    output: result.output,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    spawnProposals: result.spawnProposals,
    messageProposals: result.messageProposals,
    skipContextProposals: result.skipContextProposals,
    error: result.error,
  });
  return recomputed === bound;
}
