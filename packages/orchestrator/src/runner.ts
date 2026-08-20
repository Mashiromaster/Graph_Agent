/**
 * 节点运行器接口:控制器在临界区内同步构造运行器,异步驱动其执行。
 *
 * core 未导出 AgentSpec,故在此定义一个最小化的规格结构(identity + budget +
 * 可选 role),供控制器物化子节点时携带。`NodeFactory.create` 为同步方法——
 * 它在控制器的临界区(applySpawn)内被调用,不得阻塞。`NodeRunner.run` 是
 * 异步执行入口,由调度器(Task 8/9)在临界区外驱动。
 *
 * `RunnerCancelledError` 是节点自取消的哨兵错误:runner 抛出它以示自身请求
 * 取消,区别于普通失败。
 */

import type { AgentIdentity, AgentInput, AgentResult, NodeBudget } from "@graph-agent/core";

/**
 * 最小化的 Agent 规格。core 无对应类型,故本层自定义:节点身份 + 预算 +
 * 可选角色标签。物化子节点时由控制器组装并存入 MutableRunState.specs。
 */
export interface AgentSpec {
  readonly identity: AgentIdentity;
  readonly budget: NodeBudget;
  readonly role?: string;
}

/** 单个节点的执行器。`run` 异步返回一份待校验的 AgentResult。 */
export interface NodeRunner {
  readonly spec: AgentSpec;
  run(input: AgentInput, signal?: AbortSignal): Promise<AgentResult>;
}

/**
 * 运行器工厂。`create` 为同步方法——在控制器临界区内被调用,用给定 spec 与
 * 工具子集构造一个 NodeRunner。抛出即视为物化失败(FACTORY_ERROR)。
 */
export interface NodeFactory {
  create(args: { spec: AgentSpec; toolNames: readonly string[] }): NodeRunner;
}

/** 节点自取消哨兵:runner 抛出此错误表示自身请求取消,而非普通失败。 */
export class RunnerCancelledError extends Error {
  constructor(message = "runner cancelled") {
    super(message);
    this.name = "RunnerCancelledError";
  }
}
