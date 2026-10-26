/**
 * 实况模型接线:把 OpenAI 兼容端点包成 harness 需要的 ModelFactory。
 *
 * ## 为什么模型配置集中在此
 *
 * 实验矩阵的「模型」这一轴必须可审计:论文要报告每个数字出自哪个模型、什么温度、
 * 什么上限。把这些散落在调用处会让 §5 的实验设计表无法与代码对齐。此处的
 * `ModelSpec` 即该表的机器可读形式。
 *
 * ## 温度与方差
 *
 * 实验刻意用 temperature > 0 并重复多个种子——方差本身是要报告的指标
 * (调研 §14),不是要平均掉的噪声。因此 `temperature` 是显式必填项,
 * 不给默认值:静默的 temperature=0 会让方差一栏恒为 0 而显得「很稳」,
 * 那是一种误导。
 *
 * ## 种子如何影响调用
 *
 * OpenAI 兼容的 Chat Completions 没有通用的可复现 seed 语义(各厂实现不一)。
 * 本实验不依赖 provider 侧 seed:种子只用于**标识重复**,真实的随机性来自
 * temperature。为避免 RecordingModel 把不同种子的相同请求合并成同一个
 * requestKey,种子被写入 metadata——它不发给远端,但进入 canonicalJson,
 * 故同题不同种子得到不同的键。
 */

import {
  AnthropicMessagesModel,
  OpenAICompatibleModel,
  ScriptedModel,
  createModelResponse,
  type ModelAdapter,
  type ModelRequest,
  type ModelResponse,
} from "@graph-agent/adapter";
import { createUsage } from "@graph-agent/core";
import type { ModelFactory } from "./harness.js";

/**
 * 线格式方言。
 *
 * `openai` 走 `/v1/chat/completions`;`anthropic` 走 `/v1/messages`。两者不是
 * 换 URL 就能互换的(system 位置、content 块结构、tool_result 形态、usage
 * 字段名均不同),故由适配器区分而非在此处拼装。
 */
export type ApiDialect = "openai" | "anthropic";

/** 一个被测模型的完整配置,进 §5 的实验设计表。 */
export interface ModelSpec {
  /** 进 JSONL 的标识,须唯一。 */
  readonly name: string;
  /** 远端模型 id。 */
  readonly model: string;
  readonly baseUrl: string;
  /** 从哪个环境变量读 key(不内联密钥)。 */
  readonly apiKeyEnv: string;
  readonly temperature: number;
  readonly maxOutputTokens: number;
  readonly timeoutSeconds: number;
  /** 分层:true 表示只跑确认子集(A1/A3/A5)。 */
  readonly confirmatoryOnly: boolean;
  /** 线格式方言;省略默认 openai(保持既有行为)。 */
  readonly dialect?: ApiDialect;
  /** 额外请求体字段(如 DeepSeek 的 thinking 开关);仅 openai 方言使用。 */
  readonly extraBody?: Readonly<Record<string, unknown>>;
}

/**
 * 分层实验矩阵(计划已确认):小/中模型跑完整网格,前沿模型只跑确认子集。
 *
 * 这里不写死任何具体厂商/型号——留给运行脚本按可用凭据选择,避免把一份
 * 过期的型号清单固化进源码。给出两个样例形状供填充。
 */
export const MODEL_MATRIX_TEMPLATE: readonly ModelSpec[] = Object.freeze([
  Object.freeze({
    name: "small",
    model: "<fill-in>",
    baseUrl: "https://api.deepseek.com",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    temperature: 0.7,
    maxOutputTokens: 1024,
    timeoutSeconds: 90,
    confirmatoryOnly: false,
    extraBody: Object.freeze({ thinking: { type: "disabled" } }),
  }),
  Object.freeze({
    name: "frontier",
    model: "<fill-in>",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    temperature: 0.7,
    maxOutputTokens: 1024,
    timeoutSeconds: 120,
    confirmatoryOnly: true,
  }),
]);

/** 凭据缺失时抛出,附带应设置的变量名。 */
export class MissingCredential extends Error {
  constructor(envVar: string) {
    super(`missing credential: set ${envVar}`);
    this.name = "MissingCredential";
  }
}

/**
 * 构造实况 ModelFactory。
 *
 * 每个节点一个适配器实例(不共享),使 harness 的 RecordingModel 能逐节点
 * 记录,且一个节点的失败不污染其他节点的客户端状态。
 */
export function liveModelFactory(
  spec: ModelSpec,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ModelFactory {
  const apiKey = env[spec.apiKeyEnv];
  if (apiKey === undefined || apiKey.trim().length === 0) {
    throw new MissingCredential(spec.apiKeyEnv);
  }
  return ({ seed }) => {
    const inner =
      (spec.dialect ?? "openai") === "anthropic"
        ? new AnthropicMessagesModel({
            model: spec.model,
            apiKey,
            baseUrl: spec.baseUrl,
            timeoutSeconds: spec.timeoutSeconds,
            maxOutputTokens: spec.maxOutputTokens,
            // Anthropic 适配器有专门的 temperature 参数,直接传。
            temperature: spec.temperature,
          })
        : new OpenAICompatibleModel({
            model: spec.model,
            apiKey,
            baseUrl: spec.baseUrl,
            timeoutSeconds: spec.timeoutSeconds,
            maxOutputTokens: spec.maxOutputTokens,
            // temperature 经 extraBody 进入请求体:OpenAICompatibleModel 没有
            // 专门的 temperature 参数,而是把 extraBody 整体展开进 payload
            // (见该文件 `const body = { model, messages, ...this.extraBody }`)。
            // 若只放在 ModelSpec 里而不并入 extraBody,它会被静默丢弃,实验就会
            // 在 provider 默认温度下跑,而论文却声称用了设定值。
            extraBody: { temperature: spec.temperature, ...spec.extraBody },
          });
    // 种子标记由 harness 在 AgentNode 与 RecordingModel 之间施加(见
    // harness.runOne 的注释)。此处不再包一层:那层在 recorder 内侧,
    // 对 requestKey 无影响,只会让同一标记出现两次。
    void seed;
    return inner;
  };
}

/**
 * 把种子写入请求 metadata,使不同种子的同一请求拥有不同 requestKey。
 *
 * 不这样做的后果很隐蔽:RecordingModel 按 `valueHash(request)` 归并,而同题
 * 不同种子的请求在字段上完全相同,于是 N 个种子的响应会堆进同一个键,
 * 重放时按顺序取用——看起来能跑通,但「第 k 个种子」与「第 k 条响应」之间
 * 失去了对应关系。metadata 不随请求发往远端(见 openai-compatible 的
 * 载荷构造),故这是纯本地的区分手段。
 */
export function withSeedMetadata(inner: ModelAdapter, seed: number): ModelAdapter {
  return {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      const tagged: ModelRequest = Object.freeze({
        ...request,
        metadata: Object.freeze({ ...request.metadata, __seed: seed }),
      });
      return inner.complete(tagged);
    },
  };
}

/**
 * 故障注入模型:把某个角色的输出替换为**自信但错误**的内容。
 *
 * 用于调研 §14 的鲁棒性臂:测量一个失准角色的产出能否污染最终答案,
 * 以及 `minTrustScore` 门是否拦住它。刻意做成「自信」——措辞确定、格式规范、
 * 只有数值是错的,因为那才是真实世界里最难被下游察觉的失效模式。
 */
export function faultyModelFactory(
  base: ModelFactory,
  opts: { role: string; wrongAnswer: string },
): ModelFactory {
  return (args) => {
    if (args.role !== opts.role) {
      return base(args);
    }
    return new ScriptedModel([
      createModelResponse({
        content:
          `I verified this carefully and the result is unambiguous. ` +
          `Answer: ${opts.wrongAnswer}`,
        usage: createUsage({ inputTokens: 12, outputTokens: 18 }),
      }),
    ]);
  };
}
