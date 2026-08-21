/**
 * SessionBackedMemory: a durable SessionMemory backed by the @graph-agent/session
 * package's Storage + MessageStore. Each AgentNode's message history persists to
 * a hash-chained, append-only log so runs can resume after a crash.
 *
 * Design notes:
 * - Key: `${sessionId ?? nodeId}::${nodeId}` — one message log per (session, node).
 * - Session-open idempotency: the SessionDoc is written once per key. We probe with
 *   readSessionDoc (throws when absent) and, only on absence, open the session via the
 *   module-level createSessionDoc + writeSessionDoc (atomicWrite is overwrite-safe, so
 *   a lost race merely rewrites the same doc). We use MODULE-LEVEL append/read fns
 *   (not the Session facade) to avoid the facade's withLock — module fns don't self-lock,
 *   so there is no re-entrant/nested-lock deadlock risk.
 * - Read path: recoverSession returns the longest valid hash-chain prefix (crash-safe),
 *   truncating any torn tail entry. We prefer it over a raw readMessages.
 * - Role mapping (CONTROLLER RULING): the session MessageRole set is
 *   user|assistant|system|tool and has NO "context" role. The adapter Message.role
 *   additionally allows "context". When PERSISTING, adapter "context" maps to "user"
 *   (the node's model payload already downgrades context->user and the content already
 *   embeds an "Untrusted context from node..." prefix, so this is consistent). All other
 *   roles are identity-mapped. On LOAD, stored roles are all members of the adapter set,
 *   so they map straight back.
 * - Null-content coercion: adapter Message.content may be null; the store requires a
 *   string, so we coerce null -> "" when persisting.
 * - Determinism: no Date/random; createdAt comes from the injected clock (default () => 0).
 */

import { createAgentIdentity } from "@graph-agent/core";
import type { Message, MessageRole, ToolCall } from "@graph-agent/adapter";
import { createMessage } from "@graph-agent/adapter";
import type { Storage, MessageRole as StoredRole } from "@graph-agent/session";
import {
  appendMessage,
  createSessionDoc,
  readSessionDoc,
  recoverSession,
  writeSessionDoc,
} from "@graph-agent/session";
import type { SessionMemory } from "./memory.js";

/** Map an adapter role to a session store role: "context" -> "user", else identity. */
function toStoredRole(role: MessageRole): StoredRole {
  return role === "context" ? "user" : role;
}

export class SessionBackedMemory implements SessionMemory {
  private readonly storage: Storage;
  private readonly clock: () => number;

  constructor(input: { storage: Storage; clock?: () => number }) {
    this.storage = input.storage;
    this.clock = input.clock ?? (() => 0);
  }

  private key(nodeId: string, sessionId: string): string {
    return `${sessionId ?? nodeId}::${nodeId}`;
  }

  async load(args: { nodeId: string; sessionId: string }): Promise<readonly Message[]> {
    const k = this.key(args.nodeId, args.sessionId);
    try {
      await readSessionDoc(this.storage, k);
    } catch {
      // No SessionDoc => nothing was ever persisted for this node.
      return Object.freeze([]);
    }
    const snapshot = await recoverSession(this.storage, k);
    const messages = snapshot.messages.map((stored) => {
      const parsed = JSON.parse(stored.toolCallsJson) as ToolCall[];
      const toolCalls = parsed.length > 0 ? parsed : undefined;
      return createMessage({
        role: stored.role,
        content: stored.content,
        ...(toolCalls !== undefined ? { toolCalls } : {}),
      });
    });
    return Object.freeze(messages);
  }

  async append(args: {
    nodeId: string;
    sessionId: string;
    messages: readonly Message[];
  }): Promise<void> {
    const k = this.key(args.nodeId, args.sessionId);
    await this.ensureSession(k, args.nodeId);
    for (const message of args.messages) {
      await appendMessage(this.storage, k, {
        role: toStoredRole(message.role),
        content: message.content ?? "",
        ...(message.toolCalls !== undefined ? { toolCalls: message.toolCalls } : {}),
      });
    }
  }

  /** Write the SessionDoc once; probe with readSessionDoc, open only when absent. */
  private async ensureSession(key: string, nodeId: string): Promise<void> {
    try {
      await readSessionDoc(this.storage, key);
      return;
    } catch {
      // absent -> open below
    }
    const doc = createSessionDoc({
      sessionId: key,
      agentIdentity: createAgentIdentity({ nodeId, name: nodeId, role: "agent" }),
      createdAt: this.clock(),
    });
    await writeSessionDoc(this.storage, key, doc);
  }
}
