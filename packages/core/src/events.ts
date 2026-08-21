import { assertBoundedInt, assertNonEmptyText, assertSha256Hex } from "./guards.js";
import { canonicalJson, sha256, valueHash } from "./hash.js";

export const EventType = Object.freeze({
  NODE_STARTED: "node_started",
  NODE_COMPLETED: "node_completed",
  NODE_FAILED: "node_failed",
  BUDGET_EXCEEDED: "budget_exceeded",
  MODEL_STARTED: "model_started",
  MODEL_COMPLETED: "model_completed",
  TOOL_STARTED: "tool_started",
  TOOL_COMPLETED: "tool_completed",
  TOOL_REJECTED: "tool_rejected",
  PROPOSAL_CREATED: "proposal_created",
} as const);

export type EventType = (typeof EventType)[keyof typeof EventType];

export const GENESIS_HASH = "0".repeat(64);

export interface RunEvent {
  readonly sequence: number;
  readonly timestamp: number;
  readonly nodeId: string;
  readonly type: EventType;
  readonly inputHash: string;
  readonly outputHash: string;
  readonly metadataJson: string;
  readonly previousHash: string;
  readonly eventHash: string;
}

interface HashableFields {
  sequence: number;
  timestamp: number;
  nodeId: string;
  type: EventType;
  inputHash: string;
  outputHash: string;
  metadataJson: string;
  previousHash: string;
}

/**
 * Single source of truth for the set of fields covered by the event-chain
 * hash. Both {@link EventRecorder.record} and {@link verifyEventChain} build
 * their pre-hash object through this helper so the hashed field set can never
 * drift between recording and verification. Returns every field EXCEPT
 * `eventHash`.
 */
function hashableFields(event: HashableFields): HashableFields {
  return {
    sequence: event.sequence,
    timestamp: event.timestamp,
    nodeId: event.nodeId,
    type: event.type,
    inputHash: event.inputHash,
    outputHash: event.outputHash,
    metadataJson: event.metadataJson,
    previousHash: event.previousHash,
  };
}

function computeEventHash(fields: HashableFields): string {
  return sha256(canonicalJson(hashableFields(fields)));
}

export class EventRecorder {
  private readonly nodeId: string;
  private readonly clock: () => number;
  private readonly log: RunEvent[] = [];

  constructor(nodeId: string, clock: () => number = () => Date.now()) {
    this.nodeId = nodeId;
    this.clock = clock;
  }

  get events(): readonly RunEvent[] {
    return Object.freeze([...this.log]);
  }

  record(input: {
    type: EventType;
    inputValue?: unknown;
    outputValue?: unknown;
    metadata?: Record<string, unknown>;
  }): RunEvent {
    const sequence = this.log.length;
    const timestamp = this.clock();
    const previousHash =
      this.log.length > 0 ? this.log[this.log.length - 1]!.eventHash : GENESIS_HASH;
    const inputHash = valueHash(input.inputValue ?? null);
    const outputHash = valueHash(input.outputValue ?? null);
    const metadataJson = canonicalJson(input.metadata ?? {});
    const fields = hashableFields({
      sequence,
      timestamp,
      nodeId: this.nodeId,
      type: input.type,
      inputHash,
      outputHash,
      metadataJson,
      previousHash,
    });
    const event: RunEvent = Object.freeze({
      ...fields,
      eventHash: computeEventHash(fields),
    });
    this.log.push(event);
    return event;
  }
}

export function verifyEventChain(events: readonly RunEvent[]): boolean {
  let previousHash = GENESIS_HASH;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.sequence !== index || event.previousHash !== previousHash) {
      return false;
    }
    const recalculated = computeEventHash(hashableFields(event));
    if (recalculated !== event.eventHash) {
      return false;
    }
    previousHash = event.eventHash;
  }
  return true;
}

const EVENT_TYPE_VALUES: ReadonlySet<string> = new Set(Object.values(EventType));

/**
 * Trivial projection of a RunEvent to a canonicalJson-friendly plain object.
 * All fields are already primitives, so this is a shallow spread.
 */
export function runEventToDict(event: RunEvent): Record<string, unknown> {
  return {
    sequence: event.sequence,
    timestamp: event.timestamp,
    nodeId: event.nodeId,
    type: event.type,
    inputHash: event.inputHash,
    outputHash: event.outputHash,
    metadataJson: event.metadataJson,
    previousHash: event.previousHash,
    eventHash: event.eventHash,
  };
}

/**
 * Rebuild a RunEvent from a plain object, validating the 9 flat fields.
 * Does NOT recompute hashes — the stored eventHash/previousHash are preserved
 * verbatim so a rebuilt chain still passes {@link verifyEventChain}. Fail-closed
 * on any malformed field.
 */
export function runEventFromDict(value: unknown): RunEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("runEventFromDict expects an object");
  }
  const record = value as Record<string, unknown>;
  const type = record.type;
  if (typeof type !== "string" || !EVENT_TYPE_VALUES.has(type)) {
    throw new RangeError("type must be a known EventType value");
  }
  return Object.freeze({
    sequence: assertBoundedInt(record.sequence as number, "sequence", { min: 0 }),
    timestamp: assertBoundedInt(record.timestamp as number, "timestamp", { min: 0 }),
    nodeId: assertNonEmptyText(record.nodeId as string, "nodeId"),
    type: type as EventType,
    inputHash: assertSha256Hex(record.inputHash as string, "inputHash"),
    outputHash: assertSha256Hex(record.outputHash as string, "outputHash"),
    metadataJson: assertMetadataJson(record.metadataJson),
    previousHash: assertSha256Hex(record.previousHash as string, "previousHash"),
    eventHash: assertSha256Hex(record.eventHash as string, "eventHash"),
  });
}

function assertMetadataJson(value: unknown): string {
  if (typeof value !== "string") {
    throw new TypeError("metadataJson must be a string");
  }
  return value;
}

export function resultBindingHash(input: {
  nodeId: string;
  status: string;
  output: string | null;
  inputTokens: number;
  outputTokens: number;
  spawnProposals?: readonly unknown[];
  messageProposals?: readonly unknown[];
  skipContextProposals?: readonly unknown[];
  error?: unknown;
}): string {
  return valueHash({
    error: input.error ?? null,
    inputTokens: input.inputTokens,
    messageProposals: [...(input.messageProposals ?? [])],
    nodeId: input.nodeId,
    output: input.output,
    outputTokens: input.outputTokens,
    skipContextProposals: [...(input.skipContextProposals ?? [])],
    spawnProposals: [...(input.spawnProposals ?? [])],
    status: input.status,
  });
}
