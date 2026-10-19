/**
 * 模型类型注册表:把 `modelKind` 分派到具体的 NodeRunner 构造器。
 *
 * ## 这一层解决什么
 *
 * 控制器只认 `NodeRunner`,不认模型。`NodeFactory.create({spec, toolNames})`
 * 本就是一个**按节点**的分派点,但此前所有调用方都给全图所有节点发同一个
 * 模型。本注册表把那个分派点显式化:宿主注册若干 builder(如 jev / lightgbm /
 * llm),控制器物化子节点时按 `spec.modelKind` 取对应 builder。
 *
 * ## 不变量
 *
 * - **注册表不做校验**。`modelKind` 的合法性由控制器的 validateSpawn 对照
 *   `policy.allowedModelKinds` 裁定(信任边界在那里)。注册表只负责分派,
 *   遇到未注册的 kind 直接抛错 → 控制器记为 FACTORY_ERROR。
 * - **无默认回落到任意 builder**。未指定 modelKind 时只用显式注册的
 *   `defaultKind`;两者皆无则抛错。静默挑一个会让异质图的 resume 不可复现。
 * - **确定性**:分派纯由 modelKind 决定,无 Date/random。相同 spec + 相同
 *   注册表 ⇒ 相同 runner 类型,这是 resume 能复现异质图的前提。
 *
 * ## 与权重的关系
 *
 * 本文件只管「谁来跑」。「给谁多少预算、谁先跑」仍由 SpawnProposal 的
 * budgetShare / priority 经既有路径决定——三个标量互不混用的既有约定不变。
 */

import type { AgentSpec, NodeFactory, NodeRunner } from "./runner.js";

/** 构造某一模型类型的 runner。与 NodeFactory.create 同为同步契约。 */
export type RunnerBuilder = (args: {
  spec: AgentSpec;
  toolNames: readonly string[];
}) => NodeRunner;

export interface ModelKindRegistryOptions {
  /**
   * 节点未指定 modelKind 时使用的类型。必须已注册。省略则未指定 modelKind
   * 的节点会物化失败(FACTORY_ERROR)——刻意不静默兜底。
   */
  readonly defaultKind?: string;
}

/**
 * modelKind → RunnerBuilder 的注册表,并可直接当作 `NodeFactory` 用。
 *
 * ```ts
 * const registry = new ModelKindRegistry({ defaultKind: "llm" })
 *   .register("llm", ({ spec, toolNames }) => new AgentNode({ ... }))
 *   .register("jev", ({ spec }) => new JevNode({ ... }));
 *
 * const controller = new GraphController(
 *   registry.asNodeFactory(),
 *   createControllerPolicy({ allowedModelKinds: registry.kinds() }),
 * );
 * ```
 */
export class ModelKindRegistry implements NodeFactory {
  private readonly builders = new Map<string, RunnerBuilder>();
  private readonly defaultKind: string | undefined;

  constructor(options: ModelKindRegistryOptions = {}) {
    this.defaultKind = options.defaultKind;
  }

  /** 注册一个模型类型。同名重复注册抛错(配置错误应尽早暴露,而非后者覆盖前者)。 */
  register(kind: string, builder: RunnerBuilder): this {
    if (typeof kind !== "string" || kind.trim().length === 0) {
      throw new Error("model kind must be a non-empty string");
    }
    if (this.builders.has(kind)) {
      throw new Error(`model kind already registered: ${kind}`);
    }
    this.builders.set(kind, builder);
    return this;
  }

  /** 已注册的类型,升序。可直接喂给 `createControllerPolicy.allowedModelKinds`。 */
  kinds(): readonly string[] {
    return Object.freeze([...this.builders.keys()].sort());
  }

  has(kind: string): boolean {
    return this.builders.has(kind);
  }

  /**
   * 按 `spec.modelKind`(缺省则 `defaultKind`)分派构造 runner。
   *
   * 抛错的两种情形:未指定 modelKind 且无 defaultKind;或请求的 kind 未注册。
   * 两者都由控制器捕获为 FACTORY_ERROR,该 spawn 提案整体被拒。
   */
  create(args: { spec: AgentSpec; toolNames: readonly string[] }): NodeRunner {
    const requested = args.spec.modelKind ?? this.defaultKind;
    if (requested === undefined) {
      throw new Error(
        "node has no modelKind and the registry has no defaultKind",
      );
    }
    const builder = this.builders.get(requested);
    if (builder === undefined) {
      throw new Error(`no runner registered for model kind: ${requested}`);
    }
    return builder(args);
  }

  /** 把自身当作 NodeFactory 传出(本类已 implements NodeFactory,此处仅为可读性)。 */
  asNodeFactory(): NodeFactory {
    return this;
  }
}
