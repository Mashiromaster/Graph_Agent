import { describe, it, expect } from "vitest";
import { main } from "../src/cli.js";

function capture(): { lines: string[]; out: (line: string) => void } {
  const lines: string[] = [];
  return { lines, out: (line) => lines.push(line) };
}

describe("graph-agent CLI", () => {
  it("demo runs fully offline and completes with a valid event chain", async () => {
    const { lines, out } = capture();
    const code = await main(["demo"], out);
    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0]!) as {
      status: string;
      output: string | null;
      event_chain_valid: boolean;
      error: unknown;
    };
    expect(payload.status).toBe("completed");
    expect(payload.output).toBeTruthy();
    expect(payload.event_chain_valid).toBe(true);
    expect(payload.error).toBeNull();
  });

  it("controller-demo converges to a succeeded run with a valid controller chain", async () => {
    const { lines, out } = capture();
    const code = await main(["controller-demo"], out);
    expect(code).toBe(0);
    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0]!) as {
      snapshot: { status: string };
      controller_event_chain_valid: boolean;
    };
    expect(payload.snapshot.status).toBe("succeeded");
    expect(payload.controller_event_chain_valid).toBe(true);
  });

  it("ui rejects an out-of-range port without calling serve", async () => {
    const { out } = capture();
    let called = false;
    const stubServe = (() => {
      called = true;
      throw new Error("serve should not be called for an invalid port");
    }) as unknown as typeof import("@graph-agent/web").serve;
    const code = await main(["ui", "--port", "70000"], out, { serve: stubServe });
    expect(code).not.toBe(0);
    expect(called).toBe(false);
  });

  it("ui calls the injected serve with defaults and --no-browser", async () => {
    const { lines, out } = capture();
    const calls: unknown[][] = [];
    // A closeable fake server: it captures runUi's "close" callback and fires it
    // synchronously on the next microtask so the pending promise runUi returns
    // resolves to 0 — otherwise `await main(["ui", ...])` would hang forever
    // (the real server stays listening until closed).
    let closeCb: (() => void) | undefined;
    const fakeServer = {
      on(event: string, cb: () => void) {
        if (event === "close") {
          closeCb = cb;
        }
        return this;
      },
      close() {
        closeCb?.();
      },
    } as unknown as ReturnType<typeof import("@graph-agent/web").serve>;
    const stubServe = ((host: string, port: number, opts?: unknown) => {
      calls.push([host, port, opts]);
      // Auto-close on the next microtask so runUi's promise resolves; this lets
      // the test await main without hanging while still proving the server was
      // started and the listening line was printed first.
      queueMicrotask(() => fakeServer.close());
      return fakeServer;
    }) as unknown as typeof import("@graph-agent/web").serve;
    const code = await main(["ui", "--no-browser"], out, { serve: stubServe });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["127.0.0.1", 8765, { openBrowser: false }]);
    expect(lines.some((l) => l.includes("http://127.0.0.1:8765"))).toBe(true);
  });

  it("ui rejects a non-loopback host", async () => {
    const { out } = capture();
    let called = false;
    const stubServe = (() => {
      called = true;
      return {} as ReturnType<typeof import("@graph-agent/web").serve>;
    }) as unknown as typeof import("@graph-agent/web").serve;
    const code = await main(["ui", "--host", "0.0.0.0"], out, { serve: stubServe });
    expect(code).not.toBe(0);
    expect(called).toBe(false);
  });

  it("unknown command prints usage and returns non-zero", async () => {
    const { lines, out } = capture();
    const code = await main(["bogus"], out);
    expect(code).not.toBe(0);
    expect(lines.some((l) => l.toLowerCase().includes("usage"))).toBe(true);
  });

  it("missing command returns non-zero", async () => {
    const { lines, out } = capture();
    const code = await main([], out);
    expect(code).not.toBe(0);
    expect(lines.some((l) => l.toLowerCase().includes("usage"))).toBe(true);
  });
});
