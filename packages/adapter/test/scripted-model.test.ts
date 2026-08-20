import { describe, expect, it } from "vitest";
import { ScriptedModel } from "../src/model.js";
import { createModelRequest, createModelResponse } from "../src/model-types.js";

describe("ScriptedModel", () => {
  it("returns queued responses in FIFO order", async () => {
    const first = createModelResponse({ content: "first" });
    const second = createModelResponse({ content: "second" });
    const model = new ScriptedModel([first, second]);
    expect(await model.complete(createModelRequest({ nodeId: "n1", instructions: "a" }))).toBe(
      first,
    );
    expect(await model.complete(createModelRequest({ nodeId: "n1", instructions: "b" }))).toBe(
      second,
    );
  });

  it("records every request in order", async () => {
    const model = new ScriptedModel([
      createModelResponse({ content: "x" }),
      createModelResponse({ content: "y" }),
    ]);
    const reqA = createModelRequest({ nodeId: "n1", instructions: "a" });
    const reqB = createModelRequest({ nodeId: "n1", instructions: "b" });
    await model.complete(reqA);
    await model.complete(reqB);
    expect(model.requests).toEqual([reqA, reqB]);
  });

  it("throws when no response remains", async () => {
    const model = new ScriptedModel([createModelResponse({ content: "only" })]);
    await model.complete(createModelRequest({ nodeId: "n1", instructions: "a" }));
    await expect(
      model.complete(createModelRequest({ nodeId: "n1", instructions: "b" })),
    ).rejects.toThrow("ScriptedModel has no response remaining");
  });

  it("records the request even when exhausted", async () => {
    const model = new ScriptedModel([]);
    const req = createModelRequest({ nodeId: "n1", instructions: "a" });
    await expect(model.complete(req)).rejects.toThrow();
    expect(model.requests).toEqual([req]);
  });
});
