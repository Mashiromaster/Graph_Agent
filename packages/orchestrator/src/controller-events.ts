import { canonicalJson, sha256 } from "@graph-agent/core";

export const CONTROLLER_GENESIS_HASH = "0".repeat(64);

export type ControllerEventType =
  | "run_created"
  | "snapshot"
  | "dependency_added"
  | "execution_settled";

export interface ControllerEvent {
  readonly sequence: number;
  readonly runId: string;
  readonly type: ControllerEventType;
  readonly detailJson: string;
  readonly previousHash: string;
  readonly eventHash: string;
  readonly schemaVersion: number;
}

const SCHEMA_VERSION = 1;

interface HashableControllerFields {
  detail: object;
  previousHash: string;
  runId: string;
  schemaVersion: number;
  sequence: number;
  type: ControllerEventType;
}

/**
 * Single source of truth for the fields covered by the controller-event hash.
 * Both {@link createControllerEvent} and {@link verifyControllerEventChain}
 * build their pre-hash object through this ONE helper so the hashed field set
 * can never drift between creation and verification (sub-project-1 lesson).
 *
 * The hash preimage is over the PARSED detail object, not the detailJson
 * string, so canonicalJson re-serializes it deterministically and the
 * eventHash is independent of any detailJson formatting quirk.
 */
function hashableControllerFields(fields: HashableControllerFields): HashableControllerFields {
  return {
    detail: fields.detail,
    previousHash: fields.previousHash,
    runId: fields.runId,
    schemaVersion: fields.schemaVersion,
    sequence: fields.sequence,
    type: fields.type,
  };
}

function computeControllerEventHash(fields: HashableControllerFields): string {
  return sha256(canonicalJson(hashableControllerFields(fields)));
}

/**
 * Rejects duplicate object keys in a JSON string. JSON.parse silently keeps
 * the last value for a duplicated key, so a reviver never observes the
 * collision — the coalescing happens in the tokenizer first. This pass scans
 * the raw text, tracking the set of keys seen at each object depth, and throws
 * on any repeat within the same object.
 */
function assertNoDuplicateKeys(text: string): void {
  const stack: Set<string>[] = [];
  let index = 0;
  const length = text.length;
  while (index < length) {
    const ch = text[index]!;
    if (ch === '"') {
      // Read a string token.
      let value = "";
      index += 1;
      while (index < length) {
        const inner = text[index]!;
        if (inner === "\\") {
          value += text.slice(index, index + 2);
          index += 2;
          continue;
        }
        if (inner === '"') {
          index += 1;
          break;
        }
        value += inner;
        index += 1;
      }
      // A string that is immediately followed (after whitespace) by ':' is an
      // object key.
      let look = index;
      while (look < length && (text[look] === " " || text[look] === "\t" || text[look] === "\n" || text[look] === "\r")) {
        look += 1;
      }
      if (text[look] === ":" && stack.length > 0) {
        const keys = stack[stack.length - 1]!;
        if (keys.has(value)) {
          throw new SyntaxError(`duplicate key "${value}" in controller event detail`);
        }
        keys.add(value);
      }
      continue;
    }
    if (ch === "{") {
      stack.push(new Set<string>());
    } else if (ch === "}") {
      stack.pop();
    }
    index += 1;
  }
}

/**
 * Strict JSON parse that rejects duplicate object keys and requires a JSON
 * object result. canonicalJson never emits NaN/Infinity or duplicate keys, and
 * JSON.parse already rejects the NaN/Infinity tokens (they are not valid JSON),
 * so only duplicate-key rejection needs custom handling.
 */
function strictParse(text: string): object {
  assertNoDuplicateKeys(text);
  const parsed = JSON.parse(text) as unknown;
  if (parsed === null || typeof parsed !== "object") {
    throw new SyntaxError("controller event detail must be a JSON object");
  }
  return parsed;
}

export function createControllerEvent(
  sequence: number,
  runId: string,
  type: ControllerEventType,
  detail: object,
  previousHash: string,
): ControllerEvent {
  const detailJson = canonicalJson(detail);
  const fields = hashableControllerFields({
    detail,
    previousHash,
    runId,
    schemaVersion: SCHEMA_VERSION,
    sequence,
    type,
  });
  return Object.freeze({
    sequence,
    runId,
    type,
    detailJson,
    previousHash,
    eventHash: computeControllerEventHash(fields),
    schemaVersion: SCHEMA_VERSION,
  });
}

export function appendControllerEvent(
  events: readonly ControllerEvent[],
  runId: string,
  type: ControllerEventType,
  detail: object,
): ControllerEvent[] {
  const sequence = events.length;
  const previousHash =
    events.length > 0 ? events[events.length - 1]!.eventHash : CONTROLLER_GENESIS_HASH;
  const event = createControllerEvent(sequence, runId, type, detail, previousHash);
  return [...events, event];
}

export function verifyControllerEventChain(events: readonly ControllerEvent[]): boolean {
  if (events.length === 0) {
    return false;
  }
  const runId = events[0]!.runId;
  let previousHash = CONTROLLER_GENESIS_HASH;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (
      event.schemaVersion !== SCHEMA_VERSION ||
      event.runId !== runId ||
      event.sequence !== index ||
      event.previousHash !== previousHash
    ) {
      return false;
    }
    let detail: object;
    try {
      detail = strictParse(event.detailJson);
    } catch {
      return false;
    }
    let recalculated: string;
    try {
      recalculated = computeControllerEventHash(
        hashableControllerFields({
          detail,
          previousHash: event.previousHash,
          runId: event.runId,
          schemaVersion: event.schemaVersion,
          sequence: event.sequence,
          type: event.type,
        }),
      );
    } catch {
      return false;
    }
    if (recalculated !== event.eventHash) {
      return false;
    }
    previousHash = event.eventHash;
  }
  return true;
}

export function controllerEventDetail(event: ControllerEvent): object {
  return strictParse(event.detailJson);
}
