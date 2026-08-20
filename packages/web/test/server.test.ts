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
