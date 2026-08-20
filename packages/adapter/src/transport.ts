const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface JSONTransport {
  postJson(args: {
    url: string;
    headers: Record<string, string>;
    payload: unknown;
    timeoutSeconds: number;
  }): Promise<unknown>;
}

export class ModelTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelTransportError";
  }
}

export class InvalidModelResponse extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidModelResponse";
  }
}

function isAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

export class FetchJSONTransport implements JSONTransport {
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl: typeof fetch = fetch) {
    this.fetchImpl = fetchImpl;
  }

  async postJson(args: {
    url: string;
    headers: Record<string, string>;
    payload: unknown;
    timeoutSeconds: number;
  }): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), args.timeoutSeconds * 1000);
    let response: Response;
    try {
      response = await this.fetchImpl(args.url, {
        method: "POST",
        headers: { ...args.headers },
        body: JSON.stringify(args.payload),
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      if (isAbort(error)) {
        throw new ModelTransportError("Model endpoint request timed out");
      }
      throw new ModelTransportError("Could not reach model endpoint");
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw new ModelTransportError(`Model endpoint returned HTTP ${response.status}`);
    }

    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
      throw new ModelTransportError("Model endpoint response too large");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ModelTransportError("Model endpoint returned invalid JSON");
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ModelTransportError("Model endpoint returned a non-object JSON value");
    }

    return parsed;
  }
}
