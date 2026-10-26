/**
 * ReplayModel:按请求键重放 RecordingModel 录下的响应,不发起任何网络调用。
 *
 * ## fail-closed
 *
 * 键未命中(或该键的条目已耗尽)时**抛错,绝不编造响应、绝不回退到任意一条**。
 * 这是确定性实验的关键:若重放过程中出现了录制时不存在的请求,说明运行时在不同
 * 并发条件下走出了不同的调用轨迹——那本身就是非确定性的证据,必须显式暴露而不是
 * 被一个兜底响应掩盖。
 *
 * ## 为什么按键分组而非按全局顺序
 *
 * 改变 maxConcurrency 或完成顺序会改变**调用的全局交错**,但不改变每个节点各自发出
 * 的请求序列。因此重放按 requestKey 分组、各组内按录制顺序消费:同一键重复出现 n 次
 * 就能被取用 n 次,而跨键的取用顺序不受约束。这样才能在不同并发条件下重放同一份
 * transcript。
 *
 * 确定性:无 Date/random;无 I/O。
 */

import type { ModelRequest, ModelResponse } from "./model-types.js";
import type { ModelAdapter } from "./model.js";
import { requestKeyOf, type Transcript } from "./recording-model.js";

/** 重放时请求键缺失或条目耗尽。 */
export class ReplayMissError extends Error {
  readonly requestKey: string;

  constructor(requestKey: string, detail: string) {
    super(`ReplayModel has no recorded response for ${requestKey}: ${detail}`);
    this.name = "ReplayMissError";
    this.requestKey = requestKey;
  }
}

export class ReplayModel implements ModelAdapter {
  /** requestKey → 该键下按录制顺序排列的响应。 */
  private readonly byKey = new Map<string, ModelResponse[]>();
  /** requestKey → 下一个待消费的下标。 */
  private readonly cursor = new Map<string, number>();
  private served = 0;

  constructor(transcript: Transcript) {
    for (const entry of transcript.entries) {
      const bucket = this.byKey.get(entry.requestKey);
      if (bucket === undefined) {
        this.byKey.set(entry.requestKey, [entry.response]);
      } else {
        bucket.push(entry.response);
      }
    }
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const key = requestKeyOf(request);
    const bucket = this.byKey.get(key);
    if (bucket === undefined) {
      throw new ReplayMissError(key, "request absent from transcript");
    }
    const index = this.cursor.get(key) ?? 0;
    if (index >= bucket.length) {
      throw new ReplayMissError(
        key,
        `transcript holds ${bucket.length} response(s) but a ${index + 1}th was requested`,
      );
    }
    this.cursor.set(key, index + 1);
    this.served += 1;
    return bucket[index]!;
  }

  /** 已重放的调用次数。 */
  get servedCount(): number {
    return this.served;
  }

  /** transcript 中尚未被消费的条目数;实验结束时应为 0。 */
  get remainingCount(): number {
    let total = 0;
    for (const [key, bucket] of this.byKey) {
      total += bucket.length - (this.cursor.get(key) ?? 0);
    }
    return total;
  }
}
