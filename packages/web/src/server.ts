/**
 * Graph Agent Studio HTTP server (Node http, no framework).
 *
 * Fail-closed I/O surface: loopback-only bind, strict input validation, a
 * 2-slot execution semaphore, cross-site block, and security headers on EVERY
 * response. JSON is emitted via canonicalJson (sorted, compact, no NaN).
 * Determinism: the run path is injectable via opts.runGraph so tests avoid real
 * network and Date.now.
 */

import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { canonicalJson } from "@graph-agent/core";
import { FileStorage } from "@graph-agent/session";
import { PROVIDERS, providerSpec } from "@graph-agent/adapter";
import { staticFile } from "./static.js";
import {
  DEFAULT_PROVIDER_TYPE,
  ProviderConfig,
  parseConversation,
  runResume as realRunResume,
  runStudioGraph,
  type StudioResult,
} from "./studio.js";
import { CheckpointStore } from "./checkpoint-store.js";

type RunGraph = typeof runStudioGraph;
type RunResume = typeof realRunResume;

/**
 * Provider catalog served to the UI so the client never hardcodes a model list.
 * `suggestedModels` are hints for the picker, not an admission allowlist — the
 * server validates model ids by format (see ProviderConfig.fromPayload).
 */
const PROVIDER_CATALOG = Object.freeze(
  Object.values(PROVIDERS).map((spec) =>
    Object.freeze({
      type: spec.type,
      label: spec.label,
      base_url: spec.baseUrl,
      requires_api_key: spec.requiresApiKey,
      requires_base_url: spec.baseUrl === null,
      suggested_models: spec.suggestedModels,
    }),
  ),
);

/** Suggested models for the default provider, kept for backwards compatibility. */
const MODELS = Object.freeze([
  ...(providerSpec(DEFAULT_PROVIDER_TYPE)?.suggestedModels ?? []),
]);
const MAX_BODY_BYTES = 64000;
const MAX_CHECKPOINT_BODY_BYTES = 6_000_000;
const TASK_MAX = 2000;
const MAX_CONCURRENCY = 2;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const BODY_KEYS = ["conversation", "provider", "task"] as const;
const CHECKPOINT_SAVE_KEYS = ["checkpoint"] as const;
const RESUME_KEYS = ["id", "provider"] as const;
/** A checkpoint id is always a 64-char lowercase hex string from deriveId. Any
 * other shape (e.g. a `../` traversal id) is rejected before touching storage. */
const CHECKPOINT_ID_RE = /^[0-9a-f]{64}$/;
const DEFAULT_CHECKPOINT_DIR = ".graph-agent/checkpoints";

const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
});

/** Counting semaphore: at most `max` runs concurrently; tryAcquire is non-blocking. */
class Semaphore {
  private available: number;
  constructor(max: number) {
    this.available = max;
  }
  tryAcquire(): boolean {
    if (this.available <= 0) {
      return false;
    }
    this.available -= 1;
    return true;
  }
  release(): void {
    this.available += 1;
  }
}

function applySecurityHeaders(res: ServerResponse): void {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    res.setHeader(key, value);
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  applySecurityHeaders(res);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.statusCode = status;
  res.end(canonicalJson(payload));
}

function sendAsset(res: ServerResponse, bytes: Buffer, contentType: string): void {
  applySecurityHeaders(res);
  res.setHeader("Content-Type", contentType);
  res.statusCode = 200;
  res.end(bytes);
}

/** Reject NaN/Infinity (JSON.parse already does) + duplicate top-level keys. */
function strictParseObject(text: string): Record<string, unknown> {
  assertNoDuplicateTopLevelKeys(text);
  const parsed = JSON.parse(text) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SyntaxError("body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Rejects duplicate keys within the TOP-LEVEL object only. JSON.parse silently
 * coalesces duplicate keys, so we scan the raw text tracking object depth and
 * throw on a repeat at depth 1.
 */
function assertNoDuplicateTopLevelKeys(text: string): void {
  const seen = new Set<string>();
  let depth = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    if (ch === '"') {
      let value = "";
      i += 1;
      while (i < n) {
        const c = text[i]!;
        if (c === "\\") {
          value += text.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (c === '"') {
          i += 1;
          break;
        }
        value += c;
        i += 1;
      }
      let look = i;
      while (look < n && (text[look] === " " || text[look] === "\t" || text[look] === "\n" || text[look] === "\r")) {
        look += 1;
      }
      if (text[look] === ":" && depth === 1) {
        if (seen.has(value)) {
          throw new SyntaxError(`duplicate key "${value}" in request body`);
        }
        seen.add(value);
      }
      continue;
    }
    if (ch === "{" || ch === "[") {
      depth += 1;
    } else if (ch === "}" || ch === "]") {
      depth -= 1;
    }
    i += 1;
  }
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function hasExactKeys(obj: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(obj).sort();
  const want = [...expected].sort();
  return keys.length === want.length && want.every((k, idx) => keys[idx] === k);
}

async function handleRun(
  req: IncomingMessage,
  res: ServerResponse,
  semaphore: Semaphore,
  runGraph: RunGraph,
): Promise<void> {
  if (req.headers["sec-fetch-site"] === "cross-site") {
    sendJson(res, 403, { error: "Cross-site request blocked" });
    return;
  }
  const contentLength = Number(req.headers["content-length"] ?? "0");
  if (!Number.isFinite(contentLength) || contentLength < 1 || contentLength > MAX_BODY_BYTES) {
    sendJson(res, 413, { error: "Request body size out of bounds" });
    return;
  }
  const contentType = String(req.headers["content-type"] ?? "");
  if (!contentType.toLowerCase().startsWith("application/json")) {
    sendJson(res, 415, { error: "Content-Type must be application/json" });
    return;
  }
  if (!semaphore.tryAcquire()) {
    sendJson(res, 429, { error: "服务繁忙,请稍后重试" });
    return;
  }
  try {
    let raw: string;
    try {
      raw = await readBody(req, MAX_BODY_BYTES);
    } catch {
      sendJson(res, 413, { error: "Request body size out of bounds" });
      return;
    }
    // ── validation (all failures → 400) ─────────────────────────────────────
    let result: StudioResult;
    try {
      const body = strictParseObject(raw);
      if (!hasExactKeys(body, BODY_KEYS)) {
        throw new Error("body must have exactly keys {conversation, provider, task}");
      }
      const task = body["task"];
      if (typeof task !== "string") {
        throw new Error("task must be a string");
      }
      const trimmed = task.trim();
      if (trimmed.length < 1 || task.length > TASK_MAX) {
        throw new Error(`task length must be 1..${TASK_MAX}`);
      }
      const conversation = parseConversation(body["conversation"]);
      const provider = ProviderConfig.fromPayload(body["provider"]);
      // ── run (throw → 502) ──────────────────────────────────────────────────
      try {
        result = await runGraph({ task, provider, conversation });
      } catch {
        sendJson(res, 502, { error: "图执行失败" });
        return;
      }
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : "invalid request" });
      return;
    }
    sendJson(res, 200, result);
  } finally {
    semaphore.release();
  }
}

/** POST /api/checkpoints — save a checkpoint. Validation/bad checkpoint → 400. */
async function handleCheckpointSave(
  req: IncomingMessage,
  res: ServerResponse,
  store: CheckpointStore,
): Promise<void> {
  if (req.headers["sec-fetch-site"] === "cross-site") {
    sendJson(res, 403, { error: "Cross-site request blocked" });
    return;
  }
  const contentType = String(req.headers["content-type"] ?? "");
  if (!contentType.toLowerCase().startsWith("application/json")) {
    sendJson(res, 415, { error: "Content-Type must be application/json" });
    return;
  }
  let raw: string;
  try {
    raw = await readBody(req, MAX_CHECKPOINT_BODY_BYTES);
  } catch {
    sendJson(res, 413, { error: "Request body size out of bounds" });
    return;
  }
  try {
    const body = strictParseObject(raw);
    if (!hasExactKeys(body, CHECKPOINT_SAVE_KEYS)) {
      throw new Error("body must have exactly keys {checkpoint}");
    }
    const checkpoint = body["checkpoint"];
    if (typeof checkpoint !== "string") {
      throw new Error("checkpoint must be a string");
    }
    const { id, meta } = await store.save(checkpoint);
    sendJson(res, 200, { id, meta });
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : "invalid request" });
  }
}

/** GET /api/checkpoints — list all checkpoint metas. */
async function handleCheckpointList(res: ServerResponse, store: CheckpointStore): Promise<void> {
  const checkpoints = await store.list();
  sendJson(res, 200, { checkpoints });
}

/** GET /api/checkpoints/{id} — load one checkpoint by id → {checkpoint} / 404. */
async function handleCheckpointGet(
  res: ServerResponse,
  store: CheckpointStore,
  id: string,
): Promise<void> {
  if (id.length === 0 || !CHECKPOINT_ID_RE.test(id)) {
    // Reject any non-hex id (traversal/escape) WITHOUT touching storage.
    sendJson(res, 404, { error: "Not found" });
    return;
  }
  try {
    const checkpoint = await store.load(id);
    sendJson(res, 200, { checkpoint });
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

/** POST /api/checkpoints/resume — load + resume. Validation → 400; run throw → 502. */
async function handleCheckpointResume(
  req: IncomingMessage,
  res: ServerResponse,
  semaphore: Semaphore,
  store: CheckpointStore,
  runResume: RunResume,
): Promise<void> {
  if (req.headers["sec-fetch-site"] === "cross-site") {
    sendJson(res, 403, { error: "Cross-site request blocked" });
    return;
  }
  const contentType = String(req.headers["content-type"] ?? "");
  if (!contentType.toLowerCase().startsWith("application/json")) {
    sendJson(res, 415, { error: "Content-Type must be application/json" });
    return;
  }
  if (!semaphore.tryAcquire()) {
    sendJson(res, 429, { error: "服务繁忙,请稍后重试" });
    return;
  }
  try {
    let raw: string;
    try {
      raw = await readBody(req, MAX_BODY_BYTES);
    } catch {
      sendJson(res, 413, { error: "Request body size out of bounds" });
      return;
    }
    let result: StudioResult;
    try {
      const body = strictParseObject(raw);
      if (!hasExactKeys(body, RESUME_KEYS)) {
        throw new Error("body must have exactly keys {id, provider}");
      }
      const id = body["id"];
      if (typeof id !== "string" || !CHECKPOINT_ID_RE.test(id)) {
        // Reject any non-hex id (traversal/escape) before load/runResume.
        throw new Error("id must be a 64-char lowercase hex string");
      }
      const provider = ProviderConfig.fromPayload(body["provider"]);
      let checkpointJson: string;
      try {
        checkpointJson = await store.load(id);
      } catch {
        throw new Error("checkpoint not found");
      }
      // ── run (throw → 502) ──────────────────────────────────────────────────
      try {
        result = await runResume(checkpointJson, provider);
      } catch {
        sendJson(res, 502, { error: "图执行失败" });
        return;
      }
    } catch (err) {
      sendJson(res, 400, { error: err instanceof Error ? err.message : "invalid request" });
      return;
    }
    sendJson(res, 200, result);
  } finally {
    semaphore.release();
  }
}

function requestHandler(
  runGraph: RunGraph,
  semaphore: Semaphore,
  store: CheckpointStore,
  runResume: RunResume,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void (async () => {
      const method = req.method ?? "GET";
      const url = req.url ?? "/";
      const pathname = url.split("?")[0] ?? "/";

      if (method === "GET" && pathname === "/api/health") {
        sendJson(res, 200, {
          models: MODELS,
          provider: DEFAULT_PROVIDER_TYPE,
          providers: PROVIDER_CATALOG,
          service: "graph-agent-studio",
          status: "ok",
        });
        return;
      }

      if (method === "POST" && pathname === "/api/runs") {
        await handleRun(req, res, semaphore, runGraph);
        return;
      }
      if (method === "POST" && pathname === "/api/checkpoints") {
        await handleCheckpointSave(req, res, store);
        return;
      }
      if (method === "POST" && pathname === "/api/checkpoints/resume") {
        await handleCheckpointResume(req, res, semaphore, store, runResume);
        return;
      }
      if (method === "GET" && pathname === "/api/checkpoints") {
        await handleCheckpointList(res, store);
        return;
      }
      if (method === "GET" && pathname.startsWith("/api/checkpoints/")) {
        const id = decodeURIComponent(pathname.slice("/api/checkpoints/".length));
        await handleCheckpointGet(res, store, id);
        return;
      }
      if (method === "POST") {
        sendJson(res, 404, { error: "Not found" });
        return;
      }

      if (method === "GET") {
        const asset = staticFile(pathname);
        if (asset !== null) {
          sendAsset(res, asset.bytes, asset.contentType);
          return;
        }
      }

      sendJson(res, 404, { error: "Not found" });
    })().catch(() => {
      if (!res.headersSent) {
        sendJson(res, 502, { error: "内部错误" });
      } else {
        res.end();
      }
    });
  };
}

export function createServer(opts?: {
  runGraph?: RunGraph;
  checkpointStore?: CheckpointStore;
  runResume?: RunResume;
}): Server {
  const runGraph = opts?.runGraph ?? runStudioGraph;
  const store =
    opts?.checkpointStore ??
    new CheckpointStore({ storage: new FileStorage({ rootDir: DEFAULT_CHECKPOINT_DIR }) });
  const runResume = opts?.runResume ?? realRunResume;
  const semaphore = new Semaphore(MAX_CONCURRENCY);
  return createHttpServer(requestHandler(runGraph, semaphore, store, runResume));
}

export function serve(
  host: string,
  port: number,
  opts?: { openBrowser?: boolean; runGraph?: RunGraph },
): Server {
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(`refusing to bind non-loopback host: ${host}`);
  }
  const server = createServer(opts !== undefined && opts.runGraph !== undefined ? { runGraph: opts.runGraph } : {});
  server.listen(port, host);
  // openBrowser is intentionally a no-op: we never spawn a browser (keeps tests
  // hermetic and avoids side effects). Kept optional for API completeness.
  return server;
}
