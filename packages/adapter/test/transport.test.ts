import { describe, expect, it } from "vitest";
import { FetchJSONTransport, ModelTransportError } from "../src/transport.js";

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function makeResponse(body: string, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    async text() {
      return body;
    },
  } as unknown as Response;
}

function fakeFetch(
  impl: (url: string, init: RequestInit) => Promise<Response>,
  captured?: CapturedCall[],
): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    captured?.push({ url, init });
    return impl(url, init);
  }) as unknown as typeof fetch;
}

const args = { url: "https://example.com/x", headers: { a: "b" }, payload: { k: 1 }, timeoutSeconds: 5 };

describe("FetchJSONTransport", () => {
  it("returns the parsed object on success", async () => {
    const transport = new FetchJSONTransport(
      fakeFetch(async () => makeResponse(JSON.stringify({ hello: "world" }))),
    );
    const result = await transport.postJson(args);
    expect(result).toEqual({ hello: "world" });
  });

  it("passes redirect:error and POST body/headers", async () => {
    const captured: CapturedCall[] = [];
    const transport = new FetchJSONTransport(
      fakeFetch(async () => makeResponse("{}"), captured),
    );
    await transport.postJson(args);
    expect(captured).toHaveLength(1);
    const init = captured[0]!.init;
    expect(init.method).toBe("POST");
    expect((init as { redirect?: string }).redirect).toBe("error");
    expect(init.body).toBe(JSON.stringify({ k: 1 }));
    expect(init.headers).toMatchObject({ a: "b" });
    expect(init.signal).toBeDefined();
  });

  it("maps non-2xx to ModelTransportError with the status code", async () => {
    const transport = new FetchJSONTransport(
      fakeFetch(async () => makeResponse("nope", { ok: false, status: 503 })),
    );
    await expect(transport.postJson(args)).rejects.toThrow("Model endpoint returned HTTP 503");
    await expect(transport.postJson(args)).rejects.toBeInstanceOf(ModelTransportError);
  });

  it("maps a network throw to ModelTransportError (could not reach)", async () => {
    const transport = new FetchJSONTransport(
      fakeFetch(async () => {
        throw new TypeError("failed to fetch");
      }),
    );
    await expect(transport.postJson(args)).rejects.toThrow("Could not reach model endpoint");
  });

  it("maps an AbortError to a timeout ModelTransportError", async () => {
    const transport = new FetchJSONTransport(
      fakeFetch(async () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }),
    );
    await expect(transport.postJson(args)).rejects.toThrow("Model endpoint request timed out");
  });

  it("rejects invalid JSON", async () => {
    const transport = new FetchJSONTransport(fakeFetch(async () => makeResponse("{not json")));
    await expect(transport.postJson(args)).rejects.toThrow("Model endpoint returned invalid JSON");
  });

  it("rejects a non-object JSON value", async () => {
    const transport = new FetchJSONTransport(fakeFetch(async () => makeResponse("[1,2,3]")));
    await expect(transport.postJson(args)).rejects.toThrow(
      "Model endpoint returned a non-object JSON value",
    );
    const transport2 = new FetchJSONTransport(fakeFetch(async () => makeResponse("42")));
    await expect(transport2.postJson(args)).rejects.toThrow(
      "Model endpoint returned a non-object JSON value",
    );
  });

  it("rejects a response body over 8 MiB", async () => {
    const big = "x".repeat(8 * 1024 * 1024 + 1);
    const transport = new FetchJSONTransport(fakeFetch(async () => makeResponse(big)));
    await expect(transport.postJson(args)).rejects.toThrow("Model endpoint response too large");
  });
});
