/**
 * CheckpointStore: a FileStorage-backed durable store for v2 resumable
 * checkpoints. It validates every checkpoint through the orchestrator's
 * parseResumableCheckpoint (fail-closed on a bogus payload), derives a
 * deterministic content id, and persists idempotently.
 *
 * Layout under the injected Storage:
 * - `checkpoints/${id}.json` — the raw checkpoint JSON (write-once).
 * - `checkpoints/index.log`  — one canonicalJson(meta) line per FIRST save.
 *
 * Determinism: no Date/random. The id is derived via session deriveId; the
 * meta.createdAt comes from an injected clock (default () => 0).
 */

import { canonicalJson } from "@graph-agent/core";
import { parseResumableCheckpoint } from "@graph-agent/orchestrator";
import { FileExistsError, deriveId, type Storage } from "@graph-agent/session";

export interface CheckpointMeta {
  readonly id: string;
  readonly runId: string;
  readonly status: string;
  readonly nodeCount: number;
  readonly eventCount: number;
  readonly createdAt: number;
}

const INDEX_PATH = "checkpoints/index.log";

function checkpointPath(id: string): string {
  return `checkpoints/${id}.json`;
}

export class CheckpointStore {
  private readonly storage: Storage;
  private readonly clock: () => number;

  constructor(input: { storage: Storage; clock?: () => number }) {
    this.storage = input.storage;
    this.clock = input.clock ?? (() => 0);
  }

  /**
   * Validate + persist a checkpoint. The id is derived from stable content
   * (runId, eventCount, nodeCount), so re-saving the same checkpoint is a
   * no-op: createOnce hits FileExistsError, we return the existing id/meta and
   * do NOT append a second index line.
   */
  async save(checkpointJson: string): Promise<{ id: string; meta: CheckpointMeta }> {
    // fail-closed: parseResumableCheckpoint throws on any non-v2 / corrupt input.
    const parsed = parseResumableCheckpoint(checkpointJson);
    const runId = parsed.finalSnapshot.runId;
    const status = parsed.finalSnapshot.status;
    const nodeCount = parsed.finalSnapshot.nodes.length;
    const eventCount = parsed.events.length;
    const id = deriveId("ckpt", runId, eventCount, nodeCount);
    const meta: CheckpointMeta = {
      id,
      runId,
      status,
      nodeCount,
      eventCount,
      createdAt: this.clock(),
    };

    let created = true;
    try {
      await this.storage.createOnce(checkpointPath(id), checkpointJson);
    } catch (err) {
      if (err instanceof FileExistsError) {
        // Idempotent re-save: the checkpoint already exists; return it without
        // appending a duplicate index entry.
        created = false;
      } else {
        throw err;
      }
    }
    if (created) {
      await this.storage.appendLine(INDEX_PATH, canonicalJson(meta));
    }
    return { id, meta };
  }

  /** List all saved checkpoint metas (index absent → []; deduped by id, first wins). */
  async list(): Promise<CheckpointMeta[]> {
    const lines = await this.storage.readLines(INDEX_PATH);
    const seen = new Set<string>();
    const out: CheckpointMeta[] = [];
    for (const line of lines) {
      const meta = JSON.parse(line) as CheckpointMeta;
      if (seen.has(meta.id)) {
        continue;
      }
      seen.add(meta.id);
      out.push(meta);
    }
    return out;
  }

  /** Load a stored checkpoint JSON by id; throws if absent. */
  async load(id: string): Promise<string> {
    return this.storage.read(checkpointPath(id));
  }
}
