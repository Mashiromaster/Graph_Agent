/**
 * RecordingModel:包装任意 ModelAdapter,把每次 complete 的 (request → response)
 * 追加到内存 transcript,供随后用 ReplayModel 离线重放。
 *
 * ## 为什么需要它
 *
 * 本运行时的确定性是**以模型为条件**的:给定同一组模型响应,最终快照摘要与并发度、
 * 调度顺序、完成先后无关。但 temperature > 0 的实况调用本身不可复现,因此「运行时
 * 贡献零熵」这一命题无法只靠实况运行来检验——必须先把模型响应固定下来,再在固定
 * 响应上改变并发条件,观察摘要是否仍然逐字节相同。RecordingModel 负责固定,
 * ReplayModel 负责重放。
 *
 * ## 请求键
 *
 * 键为 `valueHash(request)`,即 core 的 `sha256(canonicalJson(request))`。
 * canonicalJson 对对象键排序,故字段书写顺序不影响键;复用 core 的实现保证与
 * 事件链、checkpoint 的哈希口径一致。
 *
 * ## 同一请求重复出现
 *
 * 同一 requestKey 可能命中多次(例如两个节点收到完全相同的输入)。transcript 保留
 * **全部**条目并保持调用顺序,ReplayModel 按键维护各自的游标依次消费,从而既能
 * 容纳重复,又不要求重放时的调用顺序与录制时全局一致——这正是允许改变并发度的前提。
 *
 * 确定性:无 Date/random;不读环境变量。
 */

import { valueHash } from "@graph-agent/core";
import type { ModelRequest, ModelResponse } from "./model-types.js";
import type { ModelAdapter } from "./model.js";

/** 一条录制条目:请求键 + 当次请求/响应。 */
export interface TranscriptEntry {
  readonly requestKey: string;
  readonly request: ModelRequest;
  readonly response: ModelResponse;
}

/** 录制产物:条目按调用顺序排列。 */
export interface Transcript {
  readonly entries: readonly TranscriptEntry[];
}

/** 计算一条请求的重放键。录制与重放共用,避免口径分叉。 */
export function requestKeyOf(request: ModelRequest): string {
  return valueHash(request);
}

export class RecordingModel implements ModelAdapter {
  private readonly inner: ModelAdapter;
  private readonly entries: TranscriptEntry[] = [];

  constructor(inner: ModelAdapter) {
    this.inner = inner;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const response = await this.inner.complete(request);
    this.entries.push(
      Object.freeze({
        requestKey: requestKeyOf(request),
        request,
        response,
      }),
    );
    return response;
  }

  /** 当前录制产物的不可变快照(按调用顺序)。 */
  transcript(): Transcript {
    return Object.freeze({ entries: Object.freeze([...this.entries]) });
  }

  /** 已录制的调用次数。 */
  get callCount(): number {
    return this.entries.length;
  }
}
