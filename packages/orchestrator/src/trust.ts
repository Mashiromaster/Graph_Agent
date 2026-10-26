/**
 * 按角色键的可信度表与指数移动平均更新。
 *
 * ## 为什么按角色键、且跨运行
 *
 * 这是运行时结构强加的结论,不是实现上的偷懒,值得在论文 §4.1 明说:
 *
 *   在「节点只执行一次、永不重入」的运行时里,**运行内的节点级 trust 学习
 *   由构造不可能**。节点 n 的 trust 要想影响任何决策,必须在 n 产出结果之后
 *   被更新并再次被读取;但 n 不会再跑,其子节点在它结算的同一 superstep 就已
 *   物化(trust 在 spawn 时固化进 identity),因此更新后的值无处可用。
 *
 * 可行的学习只有两种:跨运行,或按角色聚合。本模块取两者的交集——
 * `role → trust`,跨运行持久化。这同时契合调研 §15.3 的告诫:先用可解释的
 * 统计量与消融实验,不要过早依赖端到端 RL。
 *
 * ## 更新式
 *
 *   trust^(t+1) = (1 − α) · trust^(t) + α · reward        (调研 §7.4)
 *
 * α 固定由调用方给出;不做自适应步长——一个可解释的常数更便于在论文里报告,
 * 也避免引入第二个需要调参的自由度。
 *
 * ## 奖励信号的来源不在本模块
 *
 * 本模块只做「给定 reward 如何更新」。reward 怎么算(提案有效率 / 失败率 /
 * 任务级评分)属于评测侧,见 packages/bench。这层分离是故意的:运行时不该
 * 内置某一种质量定义。
 *
 * 确定性:纯函数;无 Date/random;序列化按角色名升序,故同一张表必得同一份 JSON。
 */

import { assertUnitInterval, canonicalJson } from "@graph-agent/core";

/** 角色 → 可信度 [0,1]。 */
export type TrustTable = ReadonlyMap<string, number>;

/** 一条奖励观测。 */
export interface TrustObservation {
  readonly role: string;
  /** [0,1];1 表示完全达成预期,0 表示完全未达成。 */
  readonly reward: number;
}

/** 新角色的初始可信度。取 1(无罪推定):未观测过的角色不因缺数据被惩罚。 */
export const DEFAULT_TRUST = 1;

/** 空表。 */
export function createTrustTable(
  entries: Readonly<Record<string, number>> = {},
): TrustTable {
  const table = new Map<string, number>();
  for (const [role, value] of Object.entries(entries)) {
    table.set(role, assertUnitInterval(value, `trust[${role}]`));
  }
  return table;
}

/** 查表;未见过的角色回退到 DEFAULT_TRUST。 */
export function trustForRole(table: TrustTable, role: string): number {
  return table.get(role) ?? DEFAULT_TRUST;
}

/**
 * 以 EMA 应用一条观测,返回**新表**(不改入参)。
 *
 * 首次观测某角色时,以 DEFAULT_TRUST 为 trust^(0) 起算——这让「第一次就表现
 * 很差」的角色立刻下降 α·(1−reward),而不是从 0 慢慢爬升。
 */
export function updateTrust(
  table: TrustTable,
  observation: TrustObservation,
  alpha: number,
): TrustTable {
  const a = assertUnitInterval(alpha, "alpha");
  const reward = assertUnitInterval(observation.reward, "reward");
  const prior = trustForRole(table, observation.role);
  const next = (1 - a) * prior + a * reward;
  const updated = new Map(table);
  // 浮点误差可能让结果微微越界,clamp 回单位区间以满足下游 assertUnitInterval。
  updated.set(observation.role, next < 0 ? 0 : next > 1 ? 1 : next);
  return updated;
}

/**
 * 批量应用观测,按角色名升序处理。
 *
 * 排序是确定性的必要条件:同一角色在一批里出现多次时,EMA 不可交换
 * (先 0.2 后 0.9 与先 0.9 后 0.2 结果不同),故必须固定处理顺序。
 * 同角色内保持入参的相对顺序(稳定排序)。
 */
export function updateTrustBatch(
  table: TrustTable,
  observations: readonly TrustObservation[],
  alpha: number,
): TrustTable {
  const sorted = [...observations]
    .map((observation, index) => ({ observation, index }))
    .sort((left, right) => {
      if (left.observation.role !== right.observation.role) {
        return left.observation.role < right.observation.role ? -1 : 1;
      }
      return left.index - right.index;
    });
  let current = table;
  for (const { observation } of sorted) {
    current = updateTrust(current, observation, alpha);
  }
  return current;
}

// ── 持久化 ────────────────────────────────────────────────────────────────────

const TRUST_SCHEMA_VERSION = 1 as const;

/** 可信度表的默认存储路径。 */
export const TRUST_TABLE_PATH = "trust/role-trust.json";

/** 序列化为 canonicalJson(角色键由 canonicalJson 自身排序)。 */
export function serializeTrustTable(table: TrustTable): string {
  const roles: Record<string, number> = {};
  for (const [role, value] of table) {
    roles[role] = value;
  }
  return canonicalJson({ schemaVersion: TRUST_SCHEMA_VERSION, roles });
}

/** 严格反序列化;任一字段非法即抛错(fail-closed)。 */
export function deserializeTrustTable(json: string): TrustTable {
  const parsed = JSON.parse(json) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SyntaxError("trust table must be a JSON object");
  }
  const root = parsed as Record<string, unknown>;
  if (root["schemaVersion"] !== TRUST_SCHEMA_VERSION) {
    throw new SyntaxError("unsupported trust table schemaVersion");
  }
  const roles = root["roles"];
  if (roles === null || typeof roles !== "object" || Array.isArray(roles)) {
    throw new SyntaxError("trust table roles must be a JSON object");
  }
  const table = new Map<string, number>();
  for (const [role, value] of Object.entries(roles as Record<string, unknown>)) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new SyntaxError(`trust[${role}] must be a finite number`);
    }
    table.set(role, assertUnitInterval(value, `trust[${role}]`));
  }
  return table;
}

/** 最小存储契约(Storage 的子集),避免为读写一张小表而依赖整个 session 门面。 */
export interface TrustStorage {
  atomicWrite(path: string, bytes: string): Promise<void>;
  read(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  withLock<T>(path: string, fn: () => Promise<T>): Promise<T>;
}

/** 读取持久化的可信度表;文件不存在时返回空表。 */
export async function loadTrustTable(
  storage: TrustStorage,
  path: string = TRUST_TABLE_PATH,
): Promise<TrustTable> {
  if (!(await storage.exists(path))) {
    return createTrustTable();
  }
  return deserializeTrustTable(await storage.read(path));
}

/** 原子写入可信度表。 */
export async function saveTrustTable(
  storage: TrustStorage,
  table: TrustTable,
  path: string = TRUST_TABLE_PATH,
): Promise<void> {
  await storage.atomicWrite(path, serializeTrustTable(table));
}

/**
 * 读—改—写一次观测批次,整体持锁。
 *
 * 持锁是必需的:多个实验进程并发跑同一张表时,无锁的读—改—写会丢更新。
 * 锁路径取表路径本身,与 session 层 `withLock` 的用法一致。
 */
export async function applyTrustObservations(
  storage: TrustStorage,
  observations: readonly TrustObservation[],
  alpha: number,
  path: string = TRUST_TABLE_PATH,
): Promise<TrustTable> {
  return storage.withLock(`${path}.lock`, async () => {
    const current = await loadTrustTable(storage, path);
    const next = updateTrustBatch(current, observations, alpha);
    await saveTrustTable(storage, next, path);
    return next;
  });
}
