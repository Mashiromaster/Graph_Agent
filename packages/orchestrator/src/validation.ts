import {
  EventType,
  NodeStatus,
  assertNonEmptyText,
  assertUnitInterval,
  verifyEventChain,
  type AgentResult,
  type MessageProposal,
  type NodeError,
  type RunEvent,
  type SkipContextProposal,
  type SpawnProposal,
  type Usage,
} from "@graph-agent/core";
import type { ControllerPolicy } from "./policy.js";
import { EdgeType, type EdgeRecord, type NodeRecord } from "./graph-models.js";
import { verifyResultBinding } from "./result-binding.js";

/**
 * Validate that {@link value} is a non-empty (post-trim) string whose length
 * does not exceed {@link limit}. Throws {@link TypeError} for a non-string and
 * {@link RangeError} for empty / too-long input. Returns the value unchanged.
 */
export function validateText(value: unknown, limit: number): string {
  const text = assertNonEmptyText(value as string, "value");
  if (text.length > limit) {
    throw new RangeError(`value must be at most ${limit} characters`);
  }
  return text;
}

/**
 * Validate a unit-interval number in [0, 1]. Delegates the boolean-reject,
 * finite, and range checks to core {@link assertUnitInterval} (which rejects
 * booleans via its typeof guard); only the {@link opts.positive} zero-reject
 * is added here. Returns the number.
 */
export function validateUnit(value: unknown, opts: { positive?: boolean } = {}): number {
  const n = assertUnitInterval(value as number, "value");
  if (opts.positive && n === 0) {
    throw new RangeError("value must be greater than 0");
  }
  return n;
}

/**
 * Normalize a list of tool names into a frozen, duplicate-free array. A bare
 * string is rejected (it must not be treated as a char-by-char iterable); the
 * input must be an array of non-empty strings each no longer than
 * {@link maxLen}.
 */
export function normalizeTools(names: unknown, maxLen: number): readonly string[] {
  if (!Array.isArray(names)) {
    throw new TypeError("tool names must be an array");
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    if (typeof name !== "string") {
      throw new TypeError(`tool names[${index}] must be a string`);
    }
    if (name.trim().length === 0) {
      throw new RangeError(`tool names[${index}] must not be empty`);
    }
    if (name.length > maxLen) {
      throw new RangeError(`tool names[${index}] must be at most ${maxLen} characters`);
    }
    if (seen.has(name)) {
      throw new RangeError(`tool names[${index}] is a duplicate: ${name}`);
    }
    seen.add(name);
    result.push(name);
  }
  return Object.freeze(result);
}

/** Return true iff {@link value} is a 64-char string of lowercase hex digits. */
export function isSha256Hex(value: unknown): boolean {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

// ── result trust boundary ──────────────────────────────────────────────────

const EVENT_TYPE_VALUES: readonly string[] = Object.values(EventType);

/** True iff {@link value} is a non-null, non-array object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True iff {@link value} is a real integer (rejects boolean, NaN, Infinity, floats). */
function isSafeInteger(value: unknown): value is number {
  return (
    typeof value === "number" &&
    !Number.isNaN(value) &&
    Number.isInteger(value)
  );
}

/** True iff {@link event} has the shape of a {@link RunEvent}. */
function isRunEventShaped(event: unknown): event is RunEvent {
  if (!isObject(event)) {
    return false;
  }
  return (
    typeof event["type"] === "string" &&
    typeof event["nodeId"] === "string" &&
    typeof event["metadataJson"] === "string" &&
    typeof event["timestamp"] === "number" &&
    typeof event["sequence"] === "number"
  );
}

/**
 * Validate a runner-produced {@link AgentResult} against the controller trust
 * boundary. Returns an error CODE string, or `null` when the result is fully
 * trusted. Any thrown error inside the body maps to `"MALFORMED_RESULT"` — the
 * gate is fail-closed. Implements the exhaustive 12-check list in order.
 */
export function validateResult(
  result: unknown,
  expectedNodeId: string,
  policy: ControllerPolicy,
): string | null {
  try {
    // 1. AgentResult-shaped object with matching nodeId.
    if (!isObject(result) || result["nodeId"] !== expectedNodeId) {
      return "SOURCE_MISMATCH";
    }
    const r = result as unknown as AgentResult;

    // 2. events: non-empty array within cap, all RunEvent-shaped, chain verifies.
    const events = r.events as unknown;
    if (
      !Array.isArray(events) ||
      events.length === 0 ||
      events.length > policy.maxEventsPerResult ||
      !events.every(isRunEventShaped) ||
      !verifyEventChain(events as readonly RunEvent[])
    ) {
      return "INVALID_EVENT_CHAIN";
    }
    const evs = events as readonly RunEvent[];

    // 3. every event belongs to the expected node.
    if (!evs.every((event) => event.nodeId === expectedNodeId)) {
      return "SOURCE_MISMATCH";
    }

    // 4. first event is NODE_STARTED.
    if (evs[0]!.type !== EventType.NODE_STARTED) {
      return "INVALID_EVENT_STATE";
    }

    // 5. terminal vs status coupling.
    const terminal = evs[evs.length - 1]!;
    if (r.status === NodeStatus.COMPLETED) {
      if (terminal.type !== EventType.NODE_COMPLETED || r.error !== null) {
        return "INVALID_EVENT_STATE";
      }
    } else if (r.status === NodeStatus.FAILED) {
      const terminalOk =
        terminal.type === EventType.NODE_FAILED ||
        terminal.type === EventType.BUDGET_EXCEEDED;
      if (!terminalOk) {
        return "INVALID_EVENT_STATE";
      }
      const error = r.error as NodeError | null;
      if (error === null || typeof error !== "object") {
        return "MALFORMED_RESULT";
      }
      validateText(error.code, policy.maxIdLength);
      validateText(error.message, policy.maxTextLength);
      if (typeof error.retryable !== "boolean") {
        return "MALFORMED_RESULT";
      }
    } else {
      return "INVALID_NODE_STATUS";
    }

    // 6. per-event schema.
    for (const event of evs) {
      if (!EVENT_TYPE_VALUES.includes(event.type)) {
        return "INVALID_EVENT_SCHEMA";
      }
      if (event.nodeId !== expectedNodeId) {
        return "INVALID_EVENT_SCHEMA";
      }
      if (
        typeof event.metadataJson !== "string" ||
        event.metadataJson.length > policy.maxTextLength
      ) {
        return "INVALID_EVENT_SCHEMA";
      }
      if (!Number.isFinite(event.timestamp)) {
        return "INVALID_EVENT_SCHEMA";
      }
      if (
        !isSha256Hex(event.inputHash) ||
        !isSha256Hex(event.outputHash) ||
        !isSha256Hex(event.previousHash) ||
        !isSha256Hex(event.eventHash)
      ) {
        return "INVALID_EVENT_SCHEMA";
      }
      // metadataJson must be parseable JSON (hash integrity covered by chain).
      JSON.parse(event.metadataJson);
    }

    // 7. output: null or a non-empty string within limit.
    if (r.output !== null) {
      validateText(r.output, policy.maxTextLength);
    }

    // 8. usage: integer token counts in [0, maxTotalTokens].
    const usage = r.usage as Usage | undefined;
    if (!isObject(usage)) {
      return "INVALID_USAGE";
    }
    const { inputTokens, outputTokens } = usage;
    if (
      !isSafeInteger(inputTokens) ||
      !isSafeInteger(outputTokens) ||
      inputTokens < 0 ||
      outputTokens < 0 ||
      inputTokens > policy.maxTotalTokens ||
      outputTokens > policy.maxTotalTokens
    ) {
      return "INVALID_USAGE";
    }

    // 9. proposal buckets are arrays.
    const spawn = r.spawnProposals as unknown;
    const message = r.messageProposals as unknown;
    const skip = r.skipContextProposals as unknown;
    if (!Array.isArray(spawn) || !Array.isArray(message) || !Array.isArray(skip)) {
      return "MALFORMED_RESULT";
    }

    // 10. total proposal count within cap.
    if (spawn.length + message.length + skip.length > policy.maxProposalsPerResult) {
      return "PROPOSAL_LIMIT";
    }

    // 11. every proposal has a valid id.
    for (const proposal of [...spawn, ...message, ...skip]) {
      if (!isObject(proposal)) {
        return "MALFORMED_RESULT";
      }
      validateText(proposal["proposalId"], policy.maxIdLength);
    }

    // 12. result-binding integrity.
    if (!verifyResultBinding(r)) {
      return "RESULT_BINDING_MISMATCH";
    }

    return null;
  } catch {
    return "MALFORMED_RESULT";
  }
}

// ── proposal validators ─────────────────────────────────────────────────────

/**
 * Read-only view of the mutable run state that the proposal validators
 * consume. They never mutate — materialization is Task 7.
 */
export interface ValidatorState {
  readonly nodes: ReadonlyMap<string, NodeRecord>;
  readonly edges: readonly EdgeRecord[];
}

type ValidationFailure = { code: string; message: string };

function fail(code: string, message: string): ValidationFailure {
  return { code, message };
}

/** Existing SPAWN edges originating from {@link nodeId}. */
function spawnEdgesFrom(state: ValidatorState, nodeId: string): readonly EdgeRecord[] {
  return state.edges.filter(
    (edge) => edge.sourceNodeId === nodeId && edge.type === EdgeType.SPAWN,
  );
}

/**
 * Validate a {@link SpawnProposal} against the parent node, run state, and
 * policy. Returns `{code,message}` on the first failure, else `null`. The 11
 * checks run in the order specified by the spec.
 */
export function validateSpawn(
  proposal: unknown,
  parent: NodeRecord,
  state: ValidatorState,
  policy: ControllerPolicy,
): ValidationFailure | null {
  // 1. shape.
  if (!isObject(proposal)) {
    return fail("MALFORMED_PROPOSAL", "spawn proposal must be an object");
  }
  const p = proposal as unknown as SpawnProposal;

  // 2. parent match.
  if (p.parentNodeId !== parent.nodeId) {
    return fail("SOURCE_MISMATCH", "parentNodeId does not match parent");
  }

  // 3. generation is parent.generation + 1.
  if (!isSafeInteger(p.generation) || p.generation !== parent.generation + 1) {
    return fail("GENERATION_MISMATCH", "generation must be parent generation + 1");
  }

  // 4. depth cap.
  if (p.generation > policy.maxGeneration) {
    return fail("DEPTH_LIMIT", "generation exceeds maxGeneration");
  }

  // 5. node cap.
  if (state.nodes.size >= policy.maxNodes) {
    return fail("NODE_LIMIT", "node count at maxNodes");
  }

  // 6. edge cap.
  if (state.edges.length >= policy.maxEdges) {
    return fail("EDGE_LIMIT", "edge count at maxEdges");
  }

  // 7. children cap.
  const existingSpawns = spawnEdgesFrom(state, parent.nodeId);
  if (existingSpawns.length >= policy.maxChildrenPerNode) {
    return fail("CHILD_LIMIT", "parent at maxChildrenPerNode");
  }

  // 8. field validation.
  let tools: readonly string[];
  try {
    tools = normalizeTools(p.toolNames, policy.maxIdLength);
    validateText(p.proposalId, policy.maxIdLength);
    validateUnit(p.priority);
    validateUnit(p.budgetShare, { positive: true });
    validateText(p.role, policy.maxTextLength);
    validateText(p.objective, policy.maxTextLength);
    validateText(p.instructions, policy.maxTextLength);
  } catch {
    return fail("MALFORMED_PROPOSAL", "spawn proposal field validation failed");
  }

  // 9. tool subset of parent's allowed set.
  const allowed = new Set(parent.allowedToolNames);
  for (const tool of tools) {
    if (!allowed.has(tool)) {
      return fail("PERMISSION_ESCALATION", `tool not permitted: ${tool}`);
    }
  }

  // 10. budget-share sum over existing SPAWN edges + this proposal ≤ 1.
  const usedShare = existingSpawns.reduce((sum, edge) => sum + edge.weight, 0);
  if (usedShare + p.budgetShare > 1) {
    return fail("INVALID_BUDGET_SHARE", "budget share sum exceeds 1");
  }

  return null;
}

/**
 * Validate a {@link MessageProposal} against its declared source node, run
 * state, and policy. Returns `{code,message}` on first failure, else `null`.
 */
export function validateMessage(
  proposal: unknown,
  source: NodeRecord,
  state: ValidatorState,
  policy: ControllerPolicy,
): ValidationFailure | null {
  if (!isObject(proposal)) {
    return fail("MALFORMED_PROPOSAL", "message proposal must be an object");
  }
  const p = proposal as unknown as MessageProposal;

  try {
    validateText(p.proposalId, policy.maxIdLength);
    validateText(p.sourceNodeId, policy.maxIdLength);
    validateText(p.targetNodeId, policy.maxIdLength);
    validateText(p.content, policy.maxTextLength);
    validateUnit(p.priority);
    if (
      !isSafeInteger(p.ttlSeconds) ||
      p.ttlSeconds < 1 ||
      p.ttlSeconds > policy.maxMessageTtlSeconds
    ) {
      return fail("MALFORMED_PROPOSAL", "ttlSeconds out of range");
    }
  } catch {
    return fail("MALFORMED_PROPOSAL", "message proposal field validation failed");
  }

  if (p.sourceNodeId !== source.nodeId) {
    return fail("SOURCE_MISMATCH", "sourceNodeId does not match source");
  }
  if (!state.nodes.has(p.targetNodeId)) {
    return fail("TARGET_NOT_FOUND", "target node not found");
  }
  if (p.targetNodeId === p.sourceNodeId) {
    return fail("SELF_EDGE", "message target equals source");
  }
  if (state.edges.length >= policy.maxEdges) {
    return fail("EDGE_LIMIT", "edge count at maxEdges");
  }

  return null;
}

/**
 * Validate a {@link SkipContextProposal} against the requester node, run
 * state, and policy. The source node must be an ancestor of the requester.
 */
export function validateSkip(
  proposal: unknown,
  requester: NodeRecord,
  state: ValidatorState,
  policy: ControllerPolicy,
): ValidationFailure | null {
  if (!isObject(proposal)) {
    return fail("MALFORMED_PROPOSAL", "skip proposal must be an object");
  }
  const p = proposal as unknown as SkipContextProposal;

  try {
    validateText(p.proposalId, policy.maxIdLength);
    validateText(p.requesterNodeId, policy.maxIdLength);
    validateText(p.sourceNodeId, policy.maxIdLength);
    validateText(p.reason, policy.maxTextLength);
    validateUnit(p.contextGate);
  } catch {
    return fail("MALFORMED_PROPOSAL", "skip proposal field validation failed");
  }

  if (p.requesterNodeId !== requester.nodeId) {
    return fail("SOURCE_MISMATCH", "requesterNodeId does not match requester");
  }
  if (!state.nodes.has(p.sourceNodeId)) {
    return fail("TARGET_NOT_FOUND", "source node not found");
  }
  if (!isAncestor(state, p.sourceNodeId, requester.nodeId)) {
    return fail("POLICY_DENIED", "source is not an ancestor of requester");
  }
  if (state.edges.length >= policy.maxEdges) {
    return fail("EDGE_LIMIT", "edge count at maxEdges");
  }

  return null;
}

/**
 * Walk the `parentNodeId` chain upward from {@link descendantId}; return true
 * iff {@link ancestorId} is encountered. A node is not its own ancestor. The
 * walk is bounded by the number of nodes to guard against cycles.
 */
export function isAncestor(
  state: ValidatorState,
  ancestorId: string,
  descendantId: string,
): boolean {
  const seen = new Set<string>();
  let current = state.nodes.get(descendantId)?.parentNodeId ?? null;
  while (current !== null && !seen.has(current)) {
    if (current === ancestorId) {
      return true;
    }
    seen.add(current);
    current = state.nodes.get(current)?.parentNodeId ?? null;
  }
  return false;
}
