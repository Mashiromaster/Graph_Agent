/**
 * Failure classification for AgentNode.
 *
 * Everything that was not a timeout used to collapse into `execution_error`
 * with `retryable: true`, which made an upstream 5xx indistinguishable from a
 * malformed response or a cancellation. The UI then had nothing specific to
 * show and fell back to blaming the user's API key.
 *
 * The distinction that matters: a transport failure is transient and worth
 * retrying; a malformed response fails identically on retry, so retrying only
 * burns quota.
 */

import { describe, expect, it } from "vitest";
import { createAgentIdentity, createAgentInput, createNodeBudget, verifyEventChain } from "@graph-agent/core";
import { InvalidModelResponse, ModelTransportError } from "@graph-agent/adapter";
import type { ModelAdapter, ModelRequest, ModelResponse } from "@graph-agent/adapter";
import { createAgentSpec } from "../src/spec.js";
import { AgentNode } from "../src/agent-node.js";

class ThrowingModel implements ModelAdapter {
  constructor(private readonly error: Error) {}
  async complete(_request: ModelRequest): Promise<ModelResponse> {
    throw this.error;
  }
}

function node(error: Error) {
  return new AgentNode({
    spec: createAgentSpec({
      identity: createAgentIdentity({
        nodeId: "n1",
        name: "Worker",
        role: "worker",
        generation: 0,
      }),
      instructions: "Do the work.",
      budget: createNodeBudget({
        maxTurns: 2,
        maxToolCalls: 2,
        maxTotalTokens: 1000,
        timeoutSeconds: 30,
      }),
    }),
    model: new ThrowingModel(error),
    clock: () => 0,
  });
}

describe("AgentNode failure classification", () => {
  it("maps a transport failure to a retryable model_error", async () => {
    const result = await node(
      new ModelTransportError("Model endpoint returned HTTP 503"),
    ).run(createAgentInput({ task: "t" }));

    expect(result.status).toBe("failed");
    expect(result.error).toEqual({
      code: "model_error",
      message: "The model endpoint could not be reached or returned an error.",
      retryable: true,
    });
    // Upstream text can echo request content, so it must not leak.
    expect(JSON.stringify(result)).not.toContain("503");
  });

  it("maps a malformed response to a non-retryable invalid_model_result", async () => {
    const result = await node(
      new InvalidModelResponse("Response has no completion choice"),
    ).run(createAgentInput({ task: "t" }));

    expect(result.status).toBe("failed");
    expect(result.error).toEqual({
      code: "invalid_model_result",
      message: "The model returned a malformed response.",
      retryable: false,
    });
    expect(JSON.stringify(result)).not.toContain("completion choice");
  });

  it("still reports an unclassified throw as execution_error", async () => {
    const result = await node(new Error("something odd")).run(
      createAgentInput({ task: "t" }),
    );
    expect(result.error).toEqual({
      code: "execution_error",
      message: "The node failed during execution.",
      retryable: true,
    });
  });

  it("keeps the event chain verifiable on every failure path", async () => {
    for (const error of [
      new ModelTransportError("boom"),
      new InvalidModelResponse("boom"),
      new Error("boom"),
    ]) {
      const result = await node(error).run(createAgentInput({ task: "t" }));
      expect(verifyEventChain(result.events)).toBe(true);
      expect(result.output).toBeNull();
    }
  });
});
