/**
 * 类型化上下文投递:把待投递内容按路由分数排序、在 token 预算内择优,
 * 再包装成目标节点可消费的 ContextPacket。
 *
 * ## 这是 claim (c) 的实现基础
 *
 * 在本模块之前,`message` 与 `skip_context` 边只记录 `sha256(content)` 而丢弃明文,
 * 两类边全仓库只被写入、从不被读取——也就是说「多 agent 通讯」在可观测意义上
 * 是个 no-op,无法评估其有效性。本模块与 scheduler 的 frontier 重建一起,
 * 使三类信息真正进入目标节点的上下文:
 *
 *   1. message      —— 同代/跨支显式消息(父节点代发,目标尚未运行)
 *   2. depends_on   —— 依赖源的实际产出(把屏障边变成数据流边,提供真实 fan-in)
 *   3. skip_context —— 祖先产出的跨代语义跳连
 *
 * ## 为什么在 frontier-freeze 时投递而非 ingest 时
 *
 * 明文若进入快照,state/topology 摘要即改变,全部 checkpoint/replay 测试失效,
 * 且审计链「仅存摘要」的性质被破坏。因此明文驻留在不被 `snapshotOf` 投影的
 * `pendingDeliveries` 缓冲里,而投递的**效果**落在 `state.inputs[nodeId]`——
 * 后者已被 v2 resumable 切片序列化,故 resume 自动可用,无需额外改动。
 *
 * ## 路由分数
 *
 * `s(u→v) = priority_u · relevance(u,v) · trust_u`(调研 §7.4)。三个因子各自
 * 可解释、可单独消融:priority 来自源节点/边,relevance 来自词法模型,trust 来自
 * 源节点身份。乘积形式意味着任一因子为 0 即不投递,这正是期望的语义。
 *
 * 确定性:纯函数;无 Date/random;排序以 `(-score, edgeId)` 断连,edgeId 由
 * deriveControllerId 派生故全局唯一且稳定。
 */

import { createContextPacket, type ContextPacket } from "@graph-agent/core";
import type { ControllerPolicy } from "./policy.js";
import {
  buildRelevanceModel,
  cosineRelevance,
  termVector,
  type RelevanceModel,
} from "./relevance.js";

/**
 * 一条待投递内容。`kind` 标明来源通道,最终写进 ContextPacket.edgeType,
 * 使目标节点的 prompt 前缀能区分「这是消息 / 依赖产出 / 跨代跳连」。
 */
export interface Delivery {
  readonly sourceNodeId: string;
  readonly content: string;
  /** 源侧 priority(消息取边 priority,依赖/跳连取源节点 priority)。 */
  readonly priority: number;
  /** 源侧可信度,用于排序与 minTrustScore 门控。 */
  readonly trust: number;
  /** 投递通道:message | depends_on | skip_context。 */
  readonly kind: string;
  /** 产生此投递的边 id,用作确定性断连键。 */
  readonly edgeId: string;
  /** 门控系数 [0,1]:skip 边取 contextGate,message 为 1。 */
  readonly gate: number;
  /**
   * 是否为**声明式数据流**(而非可裁量证据)。
   *
   * `depends_on` 边由图作者显式声明「目标必须看到源的产出」,属刚性数据流:
   * 它不该因为词法相关性低就被丢弃——那会让 reducer 模式随机失效,且把一个
   * 本应确定的数据依赖变成相关性函数质量的函数。`message`/`skip_context` 则是
   * 可裁量证据,正是路由要筛选的对象。
   *
   * 这一区分也让 claim (c) 的消融更干净:可以分别测「刚性 fan-in」与
   * 「相关性路由的可选上下文」,而不是把两者混成一个"通讯"开关。
   */
  readonly mandatory: boolean;
}

/** 打分后的投递。 */
export interface ScoredDelivery {
  readonly delivery: Delivery;
  readonly score: number;
  readonly relevance: number;
  /** 估算 token 数(见 estimateTokens)。 */
  readonly tokens: number;
}

/**
 * 粗粒度 token 估算:按 4 字符/token 向上取整,下界 1。
 *
 * 刻意不引入分词器依赖(零依赖不变量),也刻意不用模型侧的真实计数——投递选择
 * 发生在调用模型之前,真实计数此时不可得。估算只用于**相对**排序与背包容量,
 * 其系统性偏差对所有 arm 一致,不会偏向任何一个实验配置。
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** 单条投递的路由分数:priority · relevance · trust,再乘门控系数。 */
export function scoreDelivery(
  delivery: Delivery,
  targetTask: string,
  model: RelevanceModel,
): ScoredDelivery {
  const rel = cosineRelevance(
    termVector(delivery.content),
    termVector(targetTask),
    model,
  );
  const score = delivery.priority * rel * delivery.trust * delivery.gate;
  return Object.freeze({
    delivery,
    score,
    relevance: rel,
    tokens: estimateTokens(delivery.content),
  });
}

/**
 * 对一组投递打分并排序。
 *
 * 语料 = 目标任务 + 全部候选内容,故 IDF 在同一次 frontier-freeze 内一致。
 * 排序键 `(-score, edgeId)`:分数降序,同分按 edgeId 升序——edgeId 全局唯一,
 * 故排序全序且与插入顺序无关,这是摘要可复现的前提。
 */
export function rankDeliveries(
  deliveries: readonly Delivery[],
  targetTask: string,
  model?: RelevanceModel,
): ScoredDelivery[] {
  if (deliveries.length === 0) {
    return [];
  }
  const relevanceModel =
    model ??
    buildRelevanceModel([targetTask, ...deliveries.map((d) => d.content)]);
  const scored = deliveries.map((d) => scoreDelivery(d, targetTask, relevanceModel));
  scored.sort((a, b) => {
    if (a.score !== b.score) {
      return b.score - a.score;
    }
    return a.delivery.edgeId < b.delivery.edgeId
      ? -1
      : a.delivery.edgeId > b.delivery.edgeId
        ? 1
        : 0;
  });
  return scored;
}

/**
 * Top-K 后按 token 预算做贪心背包(已按分数降序,故贪心即按分数密度优先)。
 *
 * 贪心而非最优背包:最优 0/1 背包要 DP,而这里的目标是「在可解释的规则下
 * 稀疏化上下文」,不是最优化一个代理指标。贪心的行为更容易在论文里讲清楚,
 * 且与调研 §7.4 的 Top-K/背包描述一致。
 *
 * 跳过而非截断:一条超预算的长内容被跳过后,后续较短的高分内容仍可进入——
 * 截断会让一条长内容吃掉整个预算。
 */
export function selectWithinBudget(
  scored: readonly ScoredDelivery[],
  limits: { topK: number; tokenBudget: number; maxDeliveries: number },
): ScoredDelivery[] {
  // 声明式数据流(depends_on)先行入选,不参与 Top-K 与零分过滤:图作者已经
  // 声明目标必须看到源的产出,相关性函数无权否决。仍然计入 token 预算与条数
  // 上限——否则预算对等这一性质就被绕过了。
  const mandatory = scored.filter((s) => s.delivery.mandatory);
  const discretionary = scored.filter((s) => !s.delivery.mandatory);

  const selected: ScoredDelivery[] = [];
  let spent = 0;

  for (const item of mandatory) {
    if (selected.length >= limits.maxDeliveries) {
      break;
    }
    if (spent + item.tokens > limits.tokenBudget) {
      continue;
    }
    selected.push(item);
    spent += item.tokens;
  }

  for (const item of discretionary.slice(0, limits.topK)) {
    if (selected.length >= limits.maxDeliveries) {
      break;
    }
    if (item.score <= 0) {
      continue; // 零分(无共同词元 / 门控为 0 / trust 为 0)不投递
    }
    if (spent + item.tokens > limits.tokenBudget) {
      continue;
    }
    selected.push(item);
    spent += item.tokens;
  }
  return selected;
}

/**
 * 包装为 ContextPacket。
 *
 * 复用 core 的 `createContextPacket`,因为节点侧的 prompt 前缀
 * (`agent-node.ts` 的 "Untrusted context from node X (edge=…, trust=…)")
 * 已经把 ContextPacket 渲染为「不可信证据」而非系统指令——这正是调研 §8.2
 * 要求的注入形式。**不新增注入路径**:任何绕过该前缀的注入都会削弱
 * 跨 agent prompt injection 的防线。
 *
 * 空内容被丢弃:createContextPacket 对空串 fail-closed,此处先行过滤以免
 * 一条退化投递让整个 frontier-freeze 抛错。
 */
export function toContextPackets(
  selected: readonly ScoredDelivery[],
): ContextPacket[] {
  const packets: ContextPacket[] = [];
  for (const item of selected) {
    const { delivery } = item;
    if (delivery.content.trim().length === 0) {
      continue;
    }
    packets.push(
      createContextPacket({
        sourceNodeId: delivery.sourceNodeId,
        content: delivery.content,
        trust: delivery.trust,
        edgeType: delivery.kind,
      }),
    );
  }
  return packets;
}

/**
 * 源节点的可信度。
 *
 * trust 存在 `spec.identity.trustScore` 上(NodeRecord 不带该字段),而 spec 在
 * 本层是 opaque(裁决 A:orchestrator 不依赖 node),故做窄化读取并在缺失/非法时
 * 回退到 1。回退值保守地等同于「不因 trust 缺失而丢弃投递」,真正的门控由
 * policy.minTrustScore 在 assembleContext 里施加。
 *
 * 只取 specs(不取 NodeRecord)这一点让 mutations 与 scheduler 共用同一口径,
 * 避免两处各写一份而悄悄分叉。
 */
export function trustOf(
  state: { specs: Map<string, unknown> },
  nodeId: string,
): number {
  const spec = state.specs.get(nodeId) as
    | { identity?: { trustScore?: unknown } }
    | undefined;
  const raw = spec?.identity?.trustScore;
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 && raw <= 1
    ? raw
    : 1;
}

/**
 * 某节点已归档的产出文本;无归档或产出为空时返回 null。
 *
 * archivedResults 以 executionId 为键,故按 result.nodeId 线性查找。节点在一次
 * 运行里只执行一次(失败亦然),因此最多命中一条,无需消歧。
 */
export function archivedOutputOf(
  state: { archivedResults: Map<string, { nodeId: string; output: string | null }> },
  nodeId: string,
): string | null {
  for (const result of state.archivedResults.values()) {
    if (result.nodeId === nodeId) {
      const output = result.output;
      return typeof output === "string" && output.trim().length > 0 ? output : null;
    }
  }
  return null;
}

/** 把一条投递追加到目标节点的明文缓冲(该缓冲不被 snapshotOf 投影)。 */
export function bufferDelivery(
  state: { pendingDeliveries: Map<string, Delivery[]> },
  targetNodeId: string,
  delivery: Delivery,
): void {
  const bucket = state.pendingDeliveries.get(targetNodeId);
  if (bucket === undefined) {
    state.pendingDeliveries.set(targetNodeId, [delivery]);
  } else {
    bucket.push(delivery);
  }
}

/**
 * 端到端:过滤低可信源 → 打分排序 → 预算内择优 → 包装为 ContextPacket。
 *
 * `minTrustScore` 门控在**打分之前**执行:低于门槛的源无论分数多高都不得进入
 * 上下文。这让 policy.minTrustScore 真正生效——在此之前它在 TS 侧是死字段
 * (声明、默认、校验、单测齐全,但 policy.ts 之外无读取点),而 Python 侧
 * (`controller.py:117`)一直在强制。此处补上该实现差异。
 */
export function assembleContext(
  deliveries: readonly Delivery[],
  targetTask: string,
  policy: ControllerPolicy,
): ContextPacket[] {
  const trusted = deliveries.filter((d) => d.trust >= policy.minTrustScore);
  const scored = rankDeliveries(trusted, targetTask);
  const selected = selectWithinBudget(scored, {
    topK: policy.contextTopK,
    tokenBudget: policy.contextInjectionTokenBudget,
    maxDeliveries: policy.maxDeliveriesPerNode,
  });
  return toContextPackets(selected);
}
