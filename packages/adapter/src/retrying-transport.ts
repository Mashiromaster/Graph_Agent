/**
 * 带退避重试的 JSONTransport 装饰器。
 *
 * ## 为什么需要
 *
 * 实测该端点在持续负载下间歇返回 **HTTP 503**:连续 4 次同配置长任务里 2 次失败,
 * 失败与种子、与请求内容均无关(同一请求重试即成功)。AgentNode 把传输异常转为
 * 结构化 FAILED 并提交整笔预留,于是一次 503 就让该格质量记为 0。
 *
 * 这类失败**与拓扑无关**。不重试的后果是把端点可用性写进实验结论:某个臂恰好
 * 多撞上几次 503,就会显得"更差"。而本文的核心声明之一正是要把运行时与端点的
 * 噪声从拓扑效应里剥离出去。
 *
 * ## 只重试幂等且可恢复的失败
 *
 * 重试 5xx 与 429(服务端瞬态/限流)、以及超时与连接失败。**不重试 4xx**
 * (除 429):400/401/403 是请求本身的问题,重试只会放大错误并浪费配额。
 *
 * 模型调用在语义上不是幂等的(温度 > 0 时重试会得到不同回复),但这对实验无害:
 * 失败的那次调用没有产生可用响应,重试拿到的是该轮**唯一**被记录的响应。
 * RecordingModel 只记录成功返回的 (request → response) 对,故 transcript 仍然
 * 自洽,离线重放照旧成立。
 *
 * ## 退避
 *
 * 指数退避 + 确定性抖动。抖动用请求序号而非 Math.random——项目全局禁用随机源,
 * 且确定性抖动在排障时可复现。
 */

import { ModelTransportError, type JSONTransport } from "./transport.js";

export interface RetryOptions {
  /** 最大尝试次数(含首次)。 */
  readonly maxAttempts?: number;
  /** 首次退避毫秒数,随尝试次数指数增长。 */
  readonly baseDelayMs?: number;
  /** 退避上限。 */
  readonly maxDelayMs?: number;
  /** 注入的 sleep,便于测试不真的等待。 */
  readonly sleep?: (ms: number) => Promise<void>;
  /** 每次重试前的回调,用于实验日志。 */
  readonly onRetry?: (info: {
    attempt: number;
    delayMs: number;
    error: unknown;
  }) => void;
}

// 默认值按实测的 429 行为定,不是凭感觉取整数。
//
// 旧值(4 次、2s 起)总退避只有 2+4+8 = 14s,而配额窗口通常 ≥60s——14s 的退避
// 根本熬不过一个窗口。实测后果:A4 臂 9/9 全败、A5 臂 5/8 败,其中短延迟格
// (24s、67s)就是 4 次尝试在 14s 内耗尽后放弃。
//
// 6 次、5s 起、上限 60s → 总退避 5+10+20+40+60 = 135s,可跨过一个典型窗口。
// 代价是单格最坏情况多等 2 分钟;相比"整臂数据不可用"这是便宜的。
const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_BASE_DELAY_MS = 5000;
const DEFAULT_MAX_DELAY_MS = 60000;

/** 从 ModelTransportError 的消息里取 HTTP 状态码;非 HTTP 失败返回 null。 */
export function statusOf(error: unknown): number | null {
  if (!(error instanceof ModelTransportError)) {
    return null;
  }
  const match = /HTTP (\d{3})/.exec(error.message);
  return match === null ? null : Number(match[1]);
}

/**
 * 该失败是否值得重试。
 *
 * - 5xx / 429 → 是(服务端瞬态)
 * - 其他 4xx → 否(请求本身有问题,重试无意义)
 * - 无状态码的 ModelTransportError → 是(超时/连接失败)
 * - 其他异常(如 InvalidModelResponse)→ 否(响应已到达但不合法,重试不会变好)
 */
export function isRetryable(error: unknown): boolean {
  if (!(error instanceof ModelTransportError)) {
    return false;
  }
  const status = statusOf(error);
  if (status === null) {
    return true; // 超时或连接失败
  }
  return status === 429 || status >= 500;
}

export class RetryingTransport implements JSONTransport {
  private readonly inner: JSONTransport;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onRetry: RetryOptions["onRetry"];
  private requestSeq = 0;

  constructor(inner: JSONTransport, opts: RetryOptions = {}) {
    this.inner = inner;
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.sleep =
      opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.onRetry = opts.onRetry;
  }

  /** 指数退避 + 确定性抖动(抖动取自请求序号,不用随机源)。 */
  private delayFor(attempt: number, seq: number): number {
    const exponential = this.baseDelayMs * Math.pow(2, attempt - 1);
    // 抖动范围 [0, 25%),由序号决定,避免多进程同步重试。
    const jitter = (exponential * (seq % 4)) / 16;
    return Math.min(this.maxDelayMs, Math.round(exponential + jitter));
  }

  async postJson(args: {
    url: string;
    headers: Record<string, string>;
    payload: unknown;
    timeoutSeconds: number;
  }): Promise<unknown> {
    const seq = this.requestSeq++;
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        return await this.inner.postJson(args);
      } catch (error) {
        lastError = error;
        if (!isRetryable(error) || attempt === this.maxAttempts) {
          throw error;
        }
        const delayMs = this.delayFor(attempt, seq);
        this.onRetry?.({ attempt, delayMs, error });
        await this.sleep(delayMs);
      }
    }
    throw lastError;
  }
}
