/**
 * 基于 `node:https` 的 JSONTransport,用于突破 `fetch` 的 300s header 超时。
 *
 * ## 为什么不能用 fetch
 *
 * Node 的全局 `fetch` 由内置 undici 实现,HTTP/2 连接上有一个**硬编码的 300s
 * headers 超时**,且不经 `AbortSignal` 控制:
 *
 *   TypeError: fetch failed
 *     cause: HeadersTimeoutError: HTTP/2: "headers timeout after 300000"
 *
 * 该超时无法在不引入 `undici` 依赖的前提下调整(本环境甚至没有
 * `node:undici` 内置模块)。实测前沿档模型在深度轴任务上需要 363s 才返回首字节
 * ——远超 300s,于是每次调用都以客户端异常告终。
 *
 * 症状极具误导性:`modelCalls=0`、延迟 3619–4712s(重试把每次 300s 叠加),
 * 看起来像"端点对强模型更不稳定",实则是**客户端库的限制**。这是同一类混淆的
 * 第六个实例——每次都长得像模型或拓扑的性质,实则是工具链配置。
 *
 * ## 为什么 node:https 可行
 *
 * 它走 HTTP/1.1,没有 undici 的 headers 超时;超时完全由
 * `req.setTimeout(ms)` 控制,即调用方可按模型档位自行设定。仍是 Node 内置模块,
 * 不破坏零运行时依赖的不变量。
 *
 * 确定性:无 Date/random。响应体大小上限与 FetchJSONTransport 一致。
 */

import https from "node:https";
import http from "node:http";
import { ModelTransportError } from "./transport.js";
import type { JSONTransport } from "./transport.js";

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export class NodeHttpsTransport implements JSONTransport {
  async postJson(args: {
    url: string;
    headers: Record<string, string>;
    payload: unknown;
    timeoutSeconds: number;
  }): Promise<unknown> {
    let url: URL;
    try {
      url = new URL(args.url);
    } catch {
      throw new ModelTransportError("Model endpoint URL is invalid");
    }
    const body = JSON.stringify(args.payload);
    const client = url.protocol === "http:" ? http : https;

    const raw = await new Promise<string>((resolve, reject) => {
      const req = client.request(
        {
          hostname: url.hostname,
          ...(url.port ? { port: Number(url.port) } : {}),
          path: `${url.pathname}${url.search}`,
          method: "POST",
          headers: {
            ...args.headers,
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          const status = res.statusCode ?? 0;
          let size = 0;
          let text = "";
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) {
              req.destroy();
              reject(new ModelTransportError("Model endpoint response too large"));
              return;
            }
            text += chunk.toString("utf8");
          });
          res.on("end", () => {
            if (status < 200 || status >= 300) {
              // 保留与 FetchJSONTransport 相同的消息格式:RetryingTransport
              // 的 statusOf() 用正则从消息里取状态码来判定是否可重试。
              reject(new ModelTransportError(`Model endpoint returned HTTP ${status}`));
              return;
            }
            resolve(text);
          });
        },
      );
      // 全部超时控制集中在此:无 undici 的隐式 300s 上限。
      req.setTimeout(args.timeoutSeconds * 1000, () => {
        req.destroy(new ModelTransportError("Model endpoint request timed out"));
      });
      req.on("error", (error: Error) => {
        reject(
          error instanceof ModelTransportError
            ? error
            : new ModelTransportError("Could not reach model endpoint"),
        );
      });
      req.write(body);
      req.end();
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ModelTransportError("Model endpoint returned invalid JSON");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ModelTransportError("Model endpoint returned a non-object JSON value");
    }
    return parsed;
  }
}
