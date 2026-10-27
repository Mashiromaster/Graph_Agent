import { describe, expect, it } from "vitest";
import { ModelTransportError, InvalidModelResponse } from "../src/transport.js";
import type { JSONTransport } from "../src/transport.js";
import { RetryingTransport, isRetryable, statusOf } from "../src/retrying-transport.js";

const ARGS = {
  url: "https://example.com/v1/messages",
  headers: {},
  payload: {},
  timeoutSeconds: 30,
};

/** 前 n 次抛给定错误,之后返回成功值。 */
function flakyTransport(
  failures: number,
  error: unknown,
): JSONTransport & { attempts: number } {
  let attempts = 0;
  const t = {
    get attempts() {
      return attempts;
    },
    async postJson() {
      attempts += 1;
      if (attempts <= failures) {
        throw error;
      }
      return { ok: true };
    },
  };
  return t as JSONTransport & { attempts: number };
}

/** 不真的等待,记录退避时长。 */
function instantSleep(): { fn: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    fn: async (ms: number) => {
      delays.push(ms);
    },
  };
}

describe("statusOf", () => {
  it("extracts the HTTP status from a transport error", () => {
    expect(statusOf(new ModelTransportError("Model endpoint returned HTTP 503"))).toBe(503);
    expect(statusOf(new ModelTransportError("Model endpoint returned HTTP 429"))).toBe(429);
  });

  it("returns null for a non-HTTP transport failure or a different error type", () => {
    expect(statusOf(new ModelTransportError("Could not reach model endpoint"))).toBeNull();
    expect(statusOf(new InvalidModelResponse("bad shape"))).toBeNull();
    expect(statusOf(new Error("plain"))).toBeNull();
  });
});

describe("isRetryable", () => {
  it("retries 5xx and 429", () => {
    for (const status of [500, 502, 503, 504, 429]) {
      expect(isRetryable(new ModelTransportError(`Model endpoint returned HTTP ${status}`))).toBe(
        true,
      );
    }
  });

  it("does not retry other 4xx, because the request itself is the problem", () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(isRetryable(new ModelTransportError(`Model endpoint returned HTTP ${status}`))).toBe(
        false,
      );
    }
  });

  it("retries timeouts and connection failures", () => {
    expect(isRetryable(new ModelTransportError("Model endpoint request timed out"))).toBe(true);
    expect(isRetryable(new ModelTransportError("Could not reach model endpoint"))).toBe(true);
  });

  it("does not retry an invalid response: it arrived, it is just malformed", () => {
    expect(isRetryable(new InvalidModelResponse("content must be an array"))).toBe(false);
  });
});

describe("RetryingTransport", () => {
  const e503 = new ModelTransportError("Model endpoint returned HTTP 503");

  it("passes a successful call straight through", async () => {
    const inner = flakyTransport(0, e503);
    const t = new RetryingTransport(inner);
    expect(await t.postJson(ARGS)).toEqual({ ok: true });
    expect(inner.attempts).toBe(1);
  });

  it("recovers from a transient 503", async () => {
    // 实测场景:同一请求重试即成功,失败与请求内容无关。
    const inner = flakyTransport(2, e503);
    const sleep = instantSleep();
    const t = new RetryingTransport(inner, { sleep: sleep.fn });
    expect(await t.postJson(ARGS)).toEqual({ ok: true });
    expect(inner.attempts).toBe(3);
    expect(sleep.delays).toHaveLength(2);
  });

  it("gives up after maxAttempts and rethrows the last error", async () => {
    const inner = flakyTransport(99, e503);
    const sleep = instantSleep();
    const t = new RetryingTransport(inner, { maxAttempts: 3, sleep: sleep.fn });
    await expect(t.postJson(ARGS)).rejects.toThrow("HTTP 503");
    expect(inner.attempts).toBe(3);
    // 最后一次失败后不再等待。
    expect(sleep.delays).toHaveLength(2);
  });

  it("does not retry a non-retryable status", async () => {
    const inner = flakyTransport(99, new ModelTransportError("Model endpoint returned HTTP 400"));
    const sleep = instantSleep();
    const t = new RetryingTransport(inner, { sleep: sleep.fn });
    await expect(t.postJson(ARGS)).rejects.toThrow("HTTP 400");
    expect(inner.attempts).toBe(1);
    expect(sleep.delays).toEqual([]);
  });

  it("backs off exponentially and respects the cap", async () => {
    const inner = flakyTransport(99, e503);
    const sleep = instantSleep();
    const t = new RetryingTransport(inner, {
      maxAttempts: 5,
      baseDelayMs: 1000,
      maxDelayMs: 4000,
      sleep: sleep.fn,
    });
    await expect(t.postJson(ARGS)).rejects.toThrow();
    // 1000, 2000, 4000, 4000(封顶);首个请求 seq=0 → 抖动为 0。
    expect(sleep.delays).toEqual([1000, 2000, 4000, 4000]);
  });

  it("is deterministic: no Math.random in the backoff", async () => {
    const run = async () => {
      const inner = flakyTransport(99, e503);
      const sleep = instantSleep();
      const t = new RetryingTransport(inner, { maxAttempts: 4, sleep: sleep.fn });
      await expect(t.postJson(ARGS)).rejects.toThrow();
      return sleep.delays;
    };
    expect(await run()).toEqual(await run());
  });

  it("varies jitter across requests so parallel runs do not synchronise", async () => {
    const inner = flakyTransport(99, e503);
    const sleep = instantSleep();
    const t = new RetryingTransport(inner, { maxAttempts: 2, sleep: sleep.fn });
    await expect(t.postJson(ARGS)).rejects.toThrow(); // seq 0
    await expect(t.postJson(ARGS)).rejects.toThrow(); // seq 1
    expect(sleep.delays[0]).not.toBe(sleep.delays[1]);
  });

  it("reports each retry for experiment logging", async () => {
    const inner = flakyTransport(1, e503);
    const seen: { attempt: number; delayMs: number }[] = [];
    const t = new RetryingTransport(inner, {
      sleep: async () => {},
      onRetry: ({ attempt, delayMs }) => seen.push({ attempt, delayMs }),
    });
    await t.postJson(ARGS);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.attempt).toBe(1);
    expect(seen[0]!.delayMs).toBeGreaterThan(0);
  });
});
