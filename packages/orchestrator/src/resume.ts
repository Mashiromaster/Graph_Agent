/**
 * resumeController:从 v2 可恢复 checkpoint 重建一个可**续跑**的 GraphController。
 *
 * ## 语义(裁决 C:采信已完成 + 重跑未完成)
 *
 * - 已完成节点(SUCCEEDED/FAILED/BLOCKED/CANCELLED):从归档采信——重建其节点记录
 *   与执行记录、把归档的 AgentResult 投影回 state.archivedResults;**不建 runner、
 *   不设预留、不重跑、不重复计费**。它们的 state 非 READY,故不进前沿。
 * - 未完成节点:READY,或上次被中断的 RUNNING(无归档)→ 重置为 READY;经注入的
 *   factory 建 runner、恢复其预留。后续 runUntilIdle 会重跑它们。
 * - processedResults 留空:已完成执行的节点非 READY,不会被重新 ingest,故无需从
 *   归档重建决策(裁决记录)。
 *
 * ## 依赖方向(裁决 A)
 *
 * orchestrator **不依赖** @graph-agent/node。checkpoint 里的 spec 为 opaque plain
 * 记录;由调用方注入的 `rehydrateSpec` 把 plain → AgentSpec。input/result 走 core
 * 的 agentInputFromDict/agentResultFromDict。
 *
 * ## fail-closed
 *
 * 任一 spec/input/result 不可重建、archivedResults 的 nodeId ∉ snapshot、未完成节点
 * 预留之和 != finalSnapshot.budget.reservedTokens、或 committed+reserved > limit →
 * **抛错**,绝不半建控制器。
 */

import {
  agentInputFromDict,
  agentResultFromDict,
  type AgentInput,
} from "@graph-agent/core";
import type { ControllerPolicy } from "./policy.js";
import {
  NodeState,
  createEdgeRecord,
  createExecutionRecord,
  createNodeRecord,
  type NodeRecord,
} from "./graph-models.js";
import {
  createMutableRunState,
  type MutableRunState,
} from "./mutable-state.js";
import { parseResumableCheckpoint } from "./checkpoint.js";
import { GraphController } from "./controller.js";
import type { AgentSpec, NodeFactory } from "./runner.js";

/** 判断一个节点状态是否为「已完成」(终态,不再进前沿)。 */
function isCompletedState(state: string): boolean {
  return (
    state === NodeState.SUCCEEDED ||
    state === NodeState.FAILED ||
    state === NodeState.BLOCKED ||
    state === NodeState.CANCELLED
  );
}

/** 一个节点的目标(post-reset)状态:RUNNING(中断)→ READY,其余原样。 */
function resumeNodeState(state: NodeState): NodeState {
  return state === NodeState.RUNNING ? NodeState.READY : state;
}

export interface ResumeOptions {
  readonly policy: ControllerPolicy;
  readonly clock?: () => number;
  readonly rehydrateSpec: (dict: unknown) => AgentSpec;
}

/**
 * 由 v2 可恢复 checkpoint JSON 重建一个 GraphController,使其可从断点续跑。
 *
 * 完成后调用方 `runUntilIdle(runId)` 即可续跑:已完成节点采信归档不重跑,未完成
 * 节点经 factory 重建 runner 后重跑。
 */
export function resumeController(
  json: string,
  factory: NodeFactory,
  opts: ResumeOptions,
): GraphController {
  // 1. parse(已复验 v1 链 + 拓扑 digest + state digest)。
  const { events, finalSnapshot, resumable } = parseResumableCheckpoint(json);

  // 2. Pre-validate(fail-closed,在构建任何东西之前)。
  const nodeIds = new Set(finalSnapshot.nodes.map((n) => n.nodeId));

  // 2a. 每个 resumable 节点:spec 可 rehydrate、input 可重建。缓存结果以复用。
  const rehydratedSpecs = new Map<string, AgentSpec>();
  const rehydratedInputs = new Map<string, AgentInput>();
  for (const node of resumable.nodes) {
    rehydratedSpecs.set(node.nodeId, opts.rehydrateSpec(node.spec));
    rehydratedInputs.set(node.nodeId, agentInputFromDict(node.input));
  }

  // 2b. 每条归档:result 可重建、nodeId ∈ snapshot 节点。
  const rehydratedResults: { executionId: string; result: ReturnType<typeof agentResultFromDict> }[] =
    [];
  for (const archived of resumable.archivedResults) {
    if (!nodeIds.has(archived.nodeId)) {
      throw new Error(`archived result references unknown node: ${archived.nodeId}`);
    }
    rehydratedResults.push({
      executionId: archived.executionId,
      result: agentResultFromDict(archived.result),
    });
  }

  // 2c. Σ(未完成节点预留) == finalSnapshot.budget.reservedTokens。
  let pendingReservationSum = 0;
  for (const node of resumable.nodes) {
    if (!isCompletedState(resumeNodeState(node.state as NodeState))) {
      pendingReservationSum += node.reservation;
    }
  }
  if (pendingReservationSum !== finalSnapshot.budget.reservedTokens) {
    throw new Error(
      `pending reservation sum ${pendingReservationSum} != reservedTokens ${finalSnapshot.budget.reservedTokens}`,
    );
  }

  // 2d. committed + reserved <= limit。
  if (
    finalSnapshot.budget.committedTokens + finalSnapshot.budget.reservedTokens >
    finalSnapshot.budget.limitTokens
  ) {
    throw new Error("committed + reserved exceeds limit");
  }

  // 3. 建 MutableRunState 并填充。
  const state: MutableRunState = createMutableRunState(finalSnapshot.runId, opts.policy);
  state.status = finalSnapshot.status;

  // nodes:RUNNING(中断)重置 READY,其余原样重建。
  for (const node of finalSnapshot.nodes) {
    const targetState = resumeNodeState(node.state);
    const record: NodeRecord =
      targetState === node.state
        ? node // 已冻结,可直接复用。
        : createNodeRecord({
            nodeId: node.nodeId,
            name: node.name,
            role: node.role,
            parentNodeId: node.parentNodeId,
            generation: node.generation,
            priority: node.priority,
            state: targetState,
            allowedToolNames: node.allowedToolNames,
            allocationTokens: node.allocationTokens,
            // 保留模型绑定:否则被中断的 RUNNING 节点 resume 后会丢失 modelKind,
            // 异质图将无法复现。
            modelKind: node.modelKind,
          });
    state.nodes.set(node.nodeId, record);
  }

  // edges。
  for (const edge of finalSnapshot.edges) {
    state.edges.push(
      createEdgeRecord({
        edgeId: edge.edgeId,
        sourceNodeId: edge.sourceNodeId,
        targetNodeId: edge.targetNodeId,
        type: edge.type,
        priority: edge.priority,
        weight: edge.weight,
        ttlSeconds: edge.ttlSeconds,
        contentHash: edge.contentHash,
      }),
    );
  }

  // executions。
  for (const exec of finalSnapshot.executions) {
    state.executions.set(
      exec.executionId,
      createExecutionRecord({
        executionId: exec.executionId,
        nodeId: exec.nodeId,
        sequence: exec.sequence,
        state: exec.state,
        reservedTokens: exec.reservedTokens,
        committedTokens: exec.committedTokens,
        eventChainHead: exec.eventChainHead,
      }),
    );
  }

  // 标量。
  state.committedTokens = finalSnapshot.budget.committedTokens;
  state.reservedTokens = finalSnapshot.budget.reservedTokens;
  state.superstep = finalSnapshot.superstep;
  state.enqueueSequence = resumable.enqueueSequence;

  // archivedResults:逐条投影(已在 2b 校验 nodeId + 可重建)。
  for (const { executionId, result } of rehydratedResults) {
    state.archivedResults.set(executionId, result);
  }

  // 每 resumable 节点:specs + inputs;未完成(重置后 READY)→ runner + reservation。
  for (const node of resumable.nodes) {
    const spec = rehydratedSpecs.get(node.nodeId)!;
    state.specs.set(node.nodeId, spec);
    state.inputs.set(node.nodeId, rehydratedInputs.get(node.nodeId)!);

    const record = state.nodes.get(node.nodeId);
    if (record !== undefined && record.state === NodeState.READY) {
      // 未完成:重建 runner + 恢复预留。已完成节点跳过(采信归档,不重跑/计费)。
      state.runners.set(node.nodeId, factory.create({ spec, toolNames: node.toolNames }));
      state.nodeReservations.set(node.nodeId, node.reservation);
    }
  }

  // 4. 新控制器 + 受控注入,返回。
  const controller = new GraphController(factory, opts.policy, opts.clock);
  controller.adoptRun(finalSnapshot.runId, state, events);
  return controller;
}
