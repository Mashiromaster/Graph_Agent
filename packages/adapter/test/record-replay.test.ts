import { describe, expect, it } from "vitest";
import { ScriptedModel } from "../src/model.js";
import { RecordingModel, requestKeyOf } from "../src/recording-model.js";
import { ReplayMissError, ReplayModel } from "../src/replay-model.js";
import {
  createMessage,
  createModelRequest,
  createModelResponse,
} from "../src/model-types.js";

describe("requestKeyOf", () => {
  it("is stable under field write order", () => {
    // 同一逻辑请求,两种字段书写顺序:canonicalJson 排序键,故键必须相同。
    const a = createModelRequest({
      nodeId: "n1",
      instructions: "do the thing",
      metadata: { alpha: 1, beta: 2 },
    });
    const b = createModelRequest({
      instructions: "do the thing",
      metadata: { beta: 2, alpha: 1 },
      nodeId: "n1",
    });
    expect(requestKeyOf(a)).toBe(requestKeyOf(b));
  });

  it("separates requests that differ in any field", () => {
    const base = createModelRequest({ nodeId: "n1", instructions: "a" });
    const other = createModelRequest({ nodeId: "n1", instructions: "b" });
    expect(requestKeyOf(base)).not.toBe(requestKeyOf(other));
  });

  it("distinguishes differing message content", () => {
    const withOne = createModelRequest({
      nodeId: "n1",
      instructions: "sys",
      messages: [createMessage({ role: "user", content: "one" })],
    });
    const withTwo = createModelRequest({
      nodeId: "n1",
      instructions: "sys",
      messages: [createMessage({ role: "user", content: "two" })],
    });
    expect(requestKeyOf(withOne)).not.toBe(requestKeyOf(withTwo));
  });
});

describe("RecordingModel", () => {
  it("passes responses through and records in call order", async () => {
    const first = createModelResponse({ content: "first" });
    const second = createModelResponse({ content: "second" });
    const model = new RecordingModel(new ScriptedModel([first, second]));

    const reqA = createModelRequest({ nodeId: "n1", instructions: "a" });
    const reqB = createModelRequest({ nodeId: "n1", instructions: "b" });
    expect(await model.complete(reqA)).toBe(first);
    expect(await model.complete(reqB)).toBe(second);

    const { entries } = model.transcript();
    expect(entries).toHaveLength(2);
    expect(entries[0]!.request).toBe(reqA);
    expect(entries[0]!.response).toBe(first);
    expect(entries[0]!.requestKey).toBe(requestKeyOf(reqA));
    expect(entries[1]!.request).toBe(reqB);
    expect(model.callCount).toBe(2);
  });

  it("does not record a call that threw", async () => {
    const model = new RecordingModel(new ScriptedModel([]));
    await expect(
      model.complete(createModelRequest({ nodeId: "n1", instructions: "a" })),
    ).rejects.toThrow();
    expect(model.transcript().entries).toHaveLength(0);
  });

  it("returns an immutable transcript snapshot", async () => {
    const model = new RecordingModel(
      new ScriptedModel([createModelResponse({ content: "x" })]),
    );
    await model.complete(createModelRequest({ nodeId: "n1", instructions: "a" }));
    const snapshot = model.transcript();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.entries)).toBe(true);
  });
});

describe("ReplayModel", () => {
  it("round-trips a recorded transcript", async () => {
    const recorder = new RecordingModel(
      new ScriptedModel([
        createModelResponse({ content: "alpha" }),
        createModelResponse({ content: "beta" }),
      ]),
    );
    const reqA = createModelRequest({ nodeId: "n1", instructions: "a" });
    const reqB = createModelRequest({ nodeId: "n2", instructions: "b" });
    await recorder.complete(reqA);
    await recorder.complete(reqB);

    const replay = new ReplayModel(recorder.transcript());
    // 故意用与录制相反的顺序取用:跨键顺序不受约束。
    expect((await replay.complete(reqB)).content).toBe("beta");
    expect((await replay.complete(reqA)).content).toBe("alpha");
    expect(replay.servedCount).toBe(2);
    expect(replay.remainingCount).toBe(0);
  });

  it("serves a repeated request key once per recorded occurrence", async () => {
    const recorder = new RecordingModel(
      new ScriptedModel([
        createModelResponse({ content: "first" }),
        createModelResponse({ content: "second" }),
      ]),
    );
    // 同一请求两次(两个节点收到完全相同的输入)→ 同一 requestKey 两条目。
    const req = createModelRequest({ nodeId: "n1", instructions: "same" });
    await recorder.complete(req);
    await recorder.complete(req);

    const replay = new ReplayModel(recorder.transcript());
    expect((await replay.complete(req)).content).toBe("first");
    expect((await replay.complete(req)).content).toBe("second");
    expect(replay.remainingCount).toBe(0);
    await expect(replay.complete(req)).rejects.toThrow(ReplayMissError);
  });

  it("fails closed on an unrecorded request", async () => {
    const recorder = new RecordingModel(
      new ScriptedModel([createModelResponse({ content: "only" })]),
    );
    await recorder.complete(createModelRequest({ nodeId: "n1", instructions: "a" }));

    const replay = new ReplayModel(recorder.transcript());
    const unseen = createModelRequest({ nodeId: "n1", instructions: "never recorded" });
    await expect(replay.complete(unseen)).rejects.toThrow(ReplayMissError);
    await expect(replay.complete(unseen)).rejects.toThrow("absent from transcript");
  });

  it("fails closed when a key's recorded responses are exhausted", async () => {
    const recorder = new RecordingModel(
      new ScriptedModel([createModelResponse({ content: "only" })]),
    );
    const req = createModelRequest({ nodeId: "n1", instructions: "a" });
    await recorder.complete(req);

    const replay = new ReplayModel(recorder.transcript());
    await replay.complete(req);
    await expect(replay.complete(req)).rejects.toThrow(
      "transcript holds 1 response(s) but a 2th was requested",
    );
  });

  it("reports outstanding entries when a replay consumed fewer calls", async () => {
    const recorder = new RecordingModel(
      new ScriptedModel([
        createModelResponse({ content: "x" }),
        createModelResponse({ content: "y" }),
      ]),
    );
    const reqA = createModelRequest({ nodeId: "n1", instructions: "a" });
    const reqB = createModelRequest({ nodeId: "n2", instructions: "b" });
    await recorder.complete(reqA);
    await recorder.complete(reqB);

    const replay = new ReplayModel(recorder.transcript());
    await replay.complete(reqA);
    expect(replay.remainingCount).toBe(1);
  });

  it("matches a request rebuilt with a different field order", async () => {
    const recorder = new RecordingModel(
      new ScriptedModel([createModelResponse({ content: "hit" })]),
    );
    await recorder.complete(
      createModelRequest({
        nodeId: "n1",
        instructions: "sys",
        metadata: { alpha: 1, beta: 2 },
      }),
    );

    const replay = new ReplayModel(recorder.transcript());
    const reordered = createModelRequest({
      metadata: { beta: 2, alpha: 1 },
      instructions: "sys",
      nodeId: "n1",
    });
    expect((await replay.complete(reordered)).content).toBe("hit");
  });
});
