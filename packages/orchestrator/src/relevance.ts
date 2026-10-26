/**
 * 确定性词法相关性:IDF 加权余弦,语料为本次运行自身的文本集合。
 *
 * ## 为什么不用 embedding
 *
 * 两条项目不变量同时禁止它:(1) 零运行时依赖——引入 embedding 要么加 SDK 依赖,
 * 要么调远端服务;(2) 确定性——远端 embedding 服务不保证跨时间逐位一致,会把
 * 一个非确定性源塞进「运行时贡献零熵」这一命题的中心。
 *
 * 代价要在论文里如实报告:词法相关性弱于语义相关性,因此它给出的是**路由能力的
 * 下界**。这个方向对结论是保守的——正结果不会因为相关性函数太强而被怀疑,
 * null 结果则必须相应地 hedge(可能是相关性不够好,而非路由本身无用)。
 *
 * ## 算法
 *
 * 分词:小写化后按非字母数字切分,长度 ≥2 的词元保留(单字符词元信息量过低且
 * 放大噪声)。向量:词频 × IDF,其中 `idf(t) = ln((N+1)/(df(t)+1)) + 1`
 * (平滑形式,避免 df=N 时权重归零、df=0 时除零)。打分:余弦相似度,任一向量
 * 为零向量时返回 0。
 *
 * 确定性:纯函数;无 Date/random;不依赖 Map 迭代顺序以外的任何隐式顺序,而
 * 余弦求和虽按 Map 顺序累加,浮点加法的顺序差异只影响末位且两侧顺序由同一
 * 构造过程决定,故同输入必同输出。
 */

/** 词元 → 词频。 */
export type TermVector = ReadonlyMap<string, number>;

/** 在一个固定语料上构建的 IDF 表,供同一次运行内的多次打分复用。 */
export interface RelevanceModel {
  readonly idf: ReadonlyMap<string, number>;
  readonly documentCount: number;
}

const MIN_TERM_LENGTH = 2;

/** 小写化 → 非字母数字切分 → 丢弃长度 <2 的词元。 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= MIN_TERM_LENGTH) {
      tokens.push(raw);
    }
  }
  return tokens;
}

/** 词频向量。 */
export function termVector(text: string): TermVector {
  const counts = new Map<string, number>();
  for (const token of tokenize(text)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

/**
 * 由语料构建 IDF 表。`documents` 为本次运行内的全部候选文本(目标任务 + 各条
 * 待投递内容),故同一次 frontier-freeze 内的打分口径一致。
 */
export function buildRelevanceModel(documents: readonly string[]): RelevanceModel {
  const df = new Map<string, number>();
  for (const doc of documents) {
    for (const term of new Set(tokenize(doc))) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }
  const n = documents.length;
  const idf = new Map<string, number>();
  for (const [term, count] of df) {
    idf.set(term, Math.log((n + 1) / (count + 1)) + 1);
  }
  return Object.freeze({ idf, documentCount: n });
}

function weightedNorm(vector: TermVector, idf: ReadonlyMap<string, number>): number {
  let sum = 0;
  for (const [term, tf] of vector) {
    const w = tf * (idf.get(term) ?? 1);
    sum += w * w;
  }
  return Math.sqrt(sum);
}

/**
 * IDF 加权余弦相似度,值域 [0,1]。任一侧为零向量(或无共同词元)时为 0。
 *
 * 不做 clamp 之外的后处理:调用方(delivery.ts)把它当作路由分数的一个因子,
 * 任何额外的非线性变换都会让「分数 = priority · relevance · trust」这个
 * 可解释形式失真。
 */
export function cosineRelevance(
  a: TermVector,
  b: TermVector,
  model: RelevanceModel,
): number {
  const { idf } = model;
  const normA = weightedNorm(a, idf);
  const normB = weightedNorm(b, idf);
  if (normA === 0 || normB === 0) {
    return 0;
  }
  // 遍历较小的一侧,点积只在交集上非零。
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let dot = 0;
  for (const [term, tf] of small) {
    const other = large.get(term);
    if (other === undefined) {
      continue;
    }
    const w = idf.get(term) ?? 1;
    dot += tf * w * other * w;
  }
  const score = dot / (normA * normB);
  return score < 0 ? 0 : score > 1 ? 1 : score;
}

/** 便捷形式:对两段原文直接打分(内部各建一次词频向量)。 */
export function relevance(
  sourceText: string,
  targetText: string,
  model: RelevanceModel,
): number {
  return cosineRelevance(termVector(sourceText), termVector(targetText), model);
}
