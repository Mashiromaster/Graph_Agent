import type { Message } from "@graph-agent/adapter";

export interface SessionMemory {
  load(args: { nodeId: string; sessionId: string }): Promise<readonly Message[]>;
  append(args: {
    nodeId: string;
    sessionId: string;
    messages: readonly Message[];
  }): Promise<void>;
}

function keyOf(nodeId: string, sessionId: string): string {
  return `${nodeId}::${sessionId}`;
}

export class InMemorySessionMemory implements SessionMemory {
  private readonly store = new Map<string, Message[]>();
  private mutex: Promise<void> = Promise.resolve();

  private withLock<T>(work: () => T): Promise<T> {
    const run = this.mutex.then(work);
    // Keep the chain alive regardless of individual failures.
    this.mutex = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  load(args: { nodeId: string; sessionId: string }): Promise<readonly Message[]> {
    return this.withLock(() => {
      const existing = this.store.get(keyOf(args.nodeId, args.sessionId)) ?? [];
      return Object.freeze([...existing]);
    });
  }

  append(args: {
    nodeId: string;
    sessionId: string;
    messages: readonly Message[];
  }): Promise<void> {
    return this.withLock(() => {
      const key = keyOf(args.nodeId, args.sessionId);
      const existing = this.store.get(key) ?? [];
      this.store.set(key, [...existing, ...args.messages]);
    });
  }
}
