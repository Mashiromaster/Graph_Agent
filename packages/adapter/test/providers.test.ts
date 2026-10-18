import { describe, expect, it } from "vitest";
import {
  PROVIDERS,
  assertModelId,
  createProviderModel,
  providerSpec,
  providerTypes,
} from "../src/providers.js";
import { createModelRequest } from "../src/model-types.js";
import type { JSONTransport } from "../src/transport.js";

class CaptureTransport implements JSONTransport {
  calls: Array<{
    url: string;
    headers: Record<string, string>;
    payload: unknown;
    timeoutSeconds: number;
  }> = [];
  constructor(private readonly response: unknown) {}
  async postJson(args: {
    url: string;
    headers: Record<string, string>;
    payload: unknown;
    timeoutSeconds: number;
  }) {
    this.calls.push(args);
    return this.response;
  }
}

const cannedResponse = {
  choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 1 },
};

function request() {
  return createModelRequest({ nodeId: "n1", instructions: "sys" });
}

describe("provider registry", () => {
  it("looks up a known provider and returns null for unknown", () => {
    expect(providerSpec("qwen")?.label).toBe("通义千问 Qwen");
    expect(providerSpec("nope")).toBeNull();
  });

  it("does not resolve inherited Object properties as providers", () => {
    expect(providerSpec("constructor")).toBeNull();
    expect(providerSpec("toString")).toBeNull();
    expect(providerSpec("__proto__")).toBeNull();
  });

  it("exposes every provider type", () => {
    expect(providerTypes()).toEqual([
      "deepseek",
      "qwen",
      "glm",
      "kimi",
      "doubao",
      "openai",
      "anthropic",
      "local",
    ]);
  });

  it("gives every provider a usable spec", () => {
    for (const type of providerTypes()) {
      const spec = providerSpec(type)!;
      expect(spec.type).toBe(type);
      expect(spec.label.length).toBeGreaterThan(0);
      expect(spec.suggestedModels.length).toBeGreaterThan(0);
      // Only `local` may omit a default endpoint.
      if (type !== "local") {
        expect(spec.baseUrl).toMatch(/^https:\/\//);
        expect(spec.requiresApiKey).toBe(true);
        expect(spec.apiKeyEnv).not.toBeNull();
      }
    }
  });

  it("freezes the registry and its nested model lists", () => {
    expect(Object.isFrozen(PROVIDERS)).toBe(true);
    expect(Object.isFrozen(PROVIDERS["qwen"])).toBe(true);
    expect(Object.isFrozen(PROVIDERS["qwen"]!.suggestedModels)).toBe(true);
  });
});

describe("assertModelId", () => {
  it("accepts ids across the registered providers", () => {
    for (const id of [
      "deepseek-v4-flash",
      "qwen-plus",
      "glm-4.6",
      "kimi-k2-turbo-preview",
      "gpt-4o",
      "claude-sonnet-4-5",
      "qwen3:8b",
      "doubao-seed-2.0-pro",
    ]) {
      expect(assertModelId(id)).toBe(id);
    }
  });

  it("accepts an Ark ep-* inference endpoint id", () => {
    expect(assertModelId("ep-20250101-abcde")).toBe("ep-20250101-abcde");
  });

  it("trims surrounding whitespace", () => {
    expect(assertModelId("  qwen-max  ")).toBe("qwen-max");
  });

  it("rejects blank, non-string, overlong, and malformed ids", () => {
    expect(() => assertModelId("")).toThrow(/must not be blank/);
    expect(() => assertModelId("   ")).toThrow(/must not be blank/);
    expect(() => assertModelId(42)).toThrow(/must be a string/);
    expect(() => assertModelId("a".repeat(129))).toThrow(/at most 128/);
    expect(() => assertModelId("has space")).toThrow(/only letters/);
  });

  it("rejects ids that could alter the request URL", () => {
    expect(() => assertModelId("../../etc/passwd")).toThrow();
    expect(() => assertModelId("model?x=1")).toThrow();
    expect(() => assertModelId("model#frag")).toThrow();
  });
});

describe("createProviderModel", () => {
  it("routes each provider to its registry base URL with a bearer token", async () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["deepseek", "https://api.deepseek.com/v1/chat/completions"],
      ["qwen", "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"],
      ["glm", "https://open.bigmodel.cn/api/paas/v4/chat/completions"],
      ["kimi", "https://api.moonshot.cn/v1/chat/completions"],
      ["doubao", "https://ark.cn-beijing.volces.com/api/v3/chat/completions"],
      ["openai", "https://api.openai.com/v1/chat/completions"],
      ["anthropic", "https://api.anthropic.com/v1/chat/completions"],
    ];
    for (const [type, url] of cases) {
      const transport = new CaptureTransport(cannedResponse);
      const model = createProviderModel({
        type,
        model: "m-1",
        apiKey: "sk-secret-key-1234",
        transport,
      });
      await model.complete(request());
      expect(transport.calls[0]?.url).toBe(url);
      expect(transport.calls[0]?.headers["Authorization"]).toBe(
        "Bearer sk-secret-key-1234",
      );
      expect((transport.calls[0]?.payload as { model: string }).model).toBe("m-1");
    }
  });

  it("rejects an unknown provider type and lists the supported ones", () => {
    expect(() => createProviderModel({ type: "nope", model: "m" })).toThrow(
      /provider\.type must be one of .*deepseek/,
    );
  });

  it("requires base_url for the local provider", () => {
    expect(() => createProviderModel({ type: "local", model: "qwen3:8b" })).toThrow(
      /base_url is required/,
    );
  });

  it("drives a local loopback endpoint over http without an api key", async () => {
    const transport = new CaptureTransport(cannedResponse);
    const model = createProviderModel({
      type: "local",
      model: "qwen3:8b",
      baseUrl: "http://127.0.0.1:11434/v1",
      transport,
    });
    await model.complete(request());
    expect(transport.calls[0]?.url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(transport.calls[0]?.headers["Authorization"]).toBeUndefined();
  });

  it("requires an api key for providers that need one", () => {
    // Clear both the explicit key and the env fallback for this provider.
    const previous = process.env["ZHIPU_API_KEY"];
    delete process.env["ZHIPU_API_KEY"];
    try {
      expect(() => createProviderModel({ type: "glm", model: "glm-4.6" })).toThrow(
        /api_key is required/,
      );
    } finally {
      if (previous !== undefined) process.env["ZHIPU_API_KEY"] = previous;
    }
  });

  it("falls back to the provider's conventional env var", async () => {
    const previous = process.env["MOONSHOT_API_KEY"];
    process.env["MOONSHOT_API_KEY"] = "sk-from-env-5678";
    try {
      const transport = new CaptureTransport(cannedResponse);
      const model = createProviderModel({
        type: "kimi",
        model: "moonshot-v1-128k",
        transport,
      });
      await model.complete(request());
      expect(transport.calls[0]?.headers["Authorization"]).toBe("Bearer sk-from-env-5678");
    } finally {
      if (previous === undefined) delete process.env["MOONSHOT_API_KEY"];
      else process.env["MOONSHOT_API_KEY"] = previous;
    }
  });

  it("lets an explicit base_url override the registry default", async () => {
    const transport = new CaptureTransport(cannedResponse);
    const model = createProviderModel({
      type: "openai",
      model: "gpt-4o",
      apiKey: "sk-secret-key-1234",
      baseUrl: "https://gateway.example.com/v1",
      transport,
    });
    await model.complete(request());
    expect(transport.calls[0]?.url).toBe("https://gateway.example.com/v1/chat/completions");
  });

  it("rejects a plaintext http base_url on a non-loopback host", () => {
    expect(() =>
      createProviderModel({
        type: "local",
        model: "m",
        baseUrl: "http://evil.example.com/v1",
      }),
    ).toThrow(/https/);
  });

  it("validates the model id before building the adapter", () => {
    expect(() =>
      createProviderModel({ type: "openai", model: "bad model", apiKey: "sk-secret-key-1234" }),
    ).toThrow(/provider\.model/);
  });
});
