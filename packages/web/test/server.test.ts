import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createServer, serve } from "../src/server.js";
import { staticFile } from "../src/static.js";
import type { StudioResult } from "../src/studio.js";

const CANNED: StudioResult = {
  controller_event_chain_valid: true,
  elapsed_ms: 0,
  event_count: 1,
  events: [{ hash: "abcdef012345", sequence: 0, type: "run_created" }],
  live: true,
  node_results: [
    {
      node_id: "root",
      status: "completed",
      output: "canned",
      usage: { inputTokens: 1, outputTokens: 2 },
      error: null,
    },
  ],
  primary_output: "canned",
  provider: { endpoint: "https://api.deepseek.com", model: "deepseek-v4-flash", thinking: "disabled", type: "deepseek" },
  snapshot: { runId: "r", nodes: [] },
  task: "t",
};

let server: Server;
let base: string;

async function stubRunGraph(): Promise<StudioResult> {
  return CANNED;
}

const VALID_KEY = "sk-abcdefgh1234";
function validBody(): string {
  return JSON.stringify({
    task: "hello",
    conversation: [],
    provider: { type: "deepseek", api_key: VALID_KEY, model: "deepseek-v4-flash" },
  });
}

beforeEach(async () => {
  server = createServer({ runGraph: stubRunGraph as never });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function expectSecurityHeaders(res: Response): void {
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
  expect(res.headers.get("permissions-policy")).not.toBeNull();
}

describe("GET /api/health", () => {
  it("returns the health payload with security headers", async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    expectSecurityHeaders(res);
    const body = await res.json();
    expect(body).toEqual({
      models: ["deepseek-v4-flash", "deepseek-v4-pro"],
      provider: "deepseek",
      service: "graph-agent-studio",
      status: "ok",
    });
  });
});

describe("static assets", () => {
  it("serves index.html at /", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const text = await res.text();
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("/assets/app.js");
  });

  it("serves app.js as text/javascript", async () => {
    const res = await fetch(`${base}/assets/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
  });

  it("404s unknown paths", async () => {
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: "Not found" });
  });
});

describe("POST /api/runs", () => {
  it("returns 200 with a StudioResult on valid input", async () => {
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: validBody(),
    });
    expect(res.status).toBe(200);
    expectSecurityHeaders(res);
    const body = await res.json();
    expect(body).toEqual(CANNED);
  });

  it("blocks cross-site requests with 403", async () => {
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
      body: validBody(),
    });
    expect(res.status).toBe(403);
  });

  it("rejects oversize Content-Length with 413", async () => {
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "70000" },
      body: "x".repeat(70000),
    });
    expect(res.status).toBe(413);
  });

  it("rejects wrong content-type with 415", async () => {
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: validBody(),
    });
    expect(res.status).toBe(415);
  });

  it("rejects non-json body with 400", async () => {
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("rejects extra keys with 400", async () => {
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        task: "hi",
        conversation: [],
        provider: { type: "deepseek", api_key: VALID_KEY, model: "deepseek-v4-flash" },
        extra: 1,
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects missing keys with 400", async () => {
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ task: "hi", conversation: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects invalid provider with 400", async () => {
    const res = await fetch(`${base}/api/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        task: "hi",
        conversation: [],
        provider: { type: "openai", api_key: VALID_KEY, model: "deepseek-v4-flash" },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("404s POST to other paths", async () => {
    const res = await fetch(`${base}/api/other`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: validBody(),
    });
    expect(res.status).toBe(404);
  });
});

describe("serve loopback-only", () => {
  it("throws on a non-loopback host", () => {
    expect(() => serve("0.0.0.0", 0, { runGraph: stubRunGraph as never })).toThrow();
  });
});

// ── checkpoint endpoints ──────────────────────────────────────────────────

interface StubStore {
  save: (json: string) => Promise<{ id: string; meta: Record<string, unknown> }>;
  list: () => Promise<Record<string, unknown>[]>;
  load: (id: string) => Promise<string>;
}

const STUB_META = {
  id: "ckpt-1",
  runId: "r",
  status: "succeeded",
  nodeCount: 1,
  eventCount: 3,
  createdAt: 0,
};

function makeStubStore(overrides?: Partial<StubStore>): StubStore {
  return {
    save: async (_json: string) => ({ id: "ckpt-1", meta: STUB_META }),
    list: async () => [STUB_META],
    load: async (id: string) => {
      if (id === "ckpt-1") {
        return "the-checkpoint-json";
      }
      throw new Error("no such file");
    },
    ...overrides,
  };
}

async function stubRunResume(): Promise<StudioResult> {
  return CANNED;
}

function makeCheckpointServer(opts?: {
  store?: StubStore;
  runResume?: () => Promise<StudioResult>;
}): Server {
  return createServer({
    checkpointStore: (opts?.store ?? makeStubStore()) as never,
    runResume: (opts?.runResume ?? stubRunResume) as never,
  });
}

describe("checkpoint endpoints", () => {
  let cpServer: Server;
  let cpBase: string;

  async function start(server: Server): Promise<string> {
    cpServer = server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as AddressInfo;
    return `http://127.0.0.1:${addr.port}`;
  }

  afterEach(async () => {
    if (cpServer !== undefined) {
      await new Promise<void>((resolve) => cpServer.close(() => resolve()));
    }
  });

  it("POST /api/checkpoints saves and returns {id, meta}", async () => {
    cpBase = await start(makeCheckpointServer());
    const res = await fetch(`${cpBase}/api/checkpoints`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ checkpoint: "the-checkpoint-json" }),
    });
    expect(res.status).toBe(200);
    expectSecurityHeaders(res);
    const body = await res.json();
    expect(body.id).toBe("ckpt-1");
    expect(body.meta).toEqual(STUB_META);
  });

  it("POST /api/checkpoints rejects missing keys with 400", async () => {
    cpBase = await start(makeCheckpointServer());
    const res = await fetch(`${cpBase}/api/checkpoints`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nope: 1 }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/checkpoints returns 400 when the store rejects a bad checkpoint", async () => {
    cpBase = await start(
      makeCheckpointServer({
        store: makeStubStore({
          save: async () => {
            throw new Error("bogus checkpoint");
          },
        }),
      }),
    );
    const res = await fetch(`${cpBase}/api/checkpoints`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ checkpoint: "bad" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/checkpoints blocks cross-site with 403", async () => {
    cpBase = await start(makeCheckpointServer());
    const res = await fetch(`${cpBase}/api/checkpoints`, {
      method: "POST",
      headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ checkpoint: "x" }),
    });
    expect(res.status).toBe(403);
  });

  it("GET /api/checkpoints returns the list", async () => {
    cpBase = await start(makeCheckpointServer());
    const res = await fetch(`${cpBase}/api/checkpoints`);
    expect(res.status).toBe(200);
    expectSecurityHeaders(res);
    const body = await res.json();
    expect(body.checkpoints).toEqual([STUB_META]);
  });

  it("GET /api/checkpoints/:id returns {checkpoint}", async () => {
    cpBase = await start(makeCheckpointServer());
    const res = await fetch(`${cpBase}/api/checkpoints/ckpt-1`);
    expect(res.status).toBe(200);
    expectSecurityHeaders(res);
    const body = await res.json();
    expect(body.checkpoint).toBe("the-checkpoint-json");
  });

  it("GET /api/checkpoints/:id returns 404 when absent", async () => {
    cpBase = await start(makeCheckpointServer());
    const res = await fetch(`${cpBase}/api/checkpoints/missing`);
    expect(res.status).toBe(404);
  });

  it("POST /api/checkpoints/resume returns a StudioResult", async () => {
    cpBase = await start(makeCheckpointServer());
    const res = await fetch(`${cpBase}/api/checkpoints/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "ckpt-1",
        provider: { type: "deepseek", api_key: VALID_KEY, model: "deepseek-v4-flash" },
      }),
    });
    expect(res.status).toBe(200);
    expectSecurityHeaders(res);
    const body = await res.json();
    expect(body).toEqual(CANNED);
  });

  it("POST /api/checkpoints/resume rejects missing keys with 400", async () => {
    cpBase = await start(makeCheckpointServer());
    const res = await fetch(`${cpBase}/api/checkpoints/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "ckpt-1" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/checkpoints/resume rejects a bad provider with 400", async () => {
    cpBase = await start(makeCheckpointServer());
    const res = await fetch(`${cpBase}/api/checkpoints/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "ckpt-1",
        provider: { type: "openai", api_key: VALID_KEY, model: "deepseek-v4-flash" },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/checkpoints/resume returns 400 for an unknown id (load throws)", async () => {
    cpBase = await start(makeCheckpointServer());
    const res = await fetch(`${cpBase}/api/checkpoints/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "missing",
        provider: { type: "deepseek", api_key: VALID_KEY, model: "deepseek-v4-flash" },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/checkpoints/resume returns 502 when runResume throws", async () => {
    cpBase = await start(
      makeCheckpointServer({
        runResume: async () => {
          throw new Error("resume failed");
        },
      }),
    );
    const res = await fetch(`${cpBase}/api/checkpoints/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "ckpt-1",
        provider: { type: "deepseek", api_key: VALID_KEY, model: "deepseek-v4-flash" },
      }),
    });
    expect(res.status).toBe(502);
  });
});

describe("static.ts runtime asset resolution", () => {
  it("reads real index.html bytes", () => {
    const asset = staticFile("/index.html");
    expect(asset).not.toBeNull();
    expect(asset!.bytes.length).toBeGreaterThan(0);
    expect(asset!.contentType).toContain("text/html");
  });

  it("returns null for unknown paths", () => {
    expect(staticFile("/nope")).toBeNull();
  });
});
