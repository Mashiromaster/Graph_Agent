import { canonicalJson, sha256, valueHash } from "./hash.js";

export const EventType = Object.freeze({
  NODE_STARTED: "node_started",
  NODE_COMPLETED: "node_completed",
  NODE_FAILED: "node_failed",
  BUDGET_EXCEEDED: "budget_exceeded",
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

function computeEventHash(fields: {
  sequence: number;
  timestamp: number;
  nodeId: string;
  type: EventType;
  inputHash: string;
  outputHash: string;
  metadataJson: string;
  previousHash: string;
}): string {
  return sha256(canonicalJson(fields));
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
    const fields = {
      sequence,
      timestamp,
      nodeId: this.nodeId,
      type: input.type,
      inputHash,
      outputHash,
      metadataJson,
      previousHash,
    };
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
    const recalculated = computeEventHash({
      sequence: event.sequence,
      timestamp: event.timestamp,
      nodeId: event.nodeId,
      type: event.type,
      inputHash: event.inputHash,
      outputHash: event.outputHash,
      metadataJson: event.metadataJson,
      previousHash: event.previousHash,
    });
    if (recalculated !== event.eventHash) {
      return false;
    }
    previousHash = event.eventHash;
  }
  return true;
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
