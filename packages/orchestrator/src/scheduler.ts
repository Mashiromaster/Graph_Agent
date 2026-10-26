/**
 * 超级步(super-step)调度器构件 + 结果归并。
 *
 * 这些函数在控制器持有全局锁的前提下操作 `MutableRunState`——它们本身不获取
 * 锁,也不驱动 runner 执行;真正的锁持有编排循环在 Task 9 的控制器里。本文件
 * 提供控制器调用的确定性构件:冻结前沿并领取执行、归并结果、异常结算、失败
 * 依赖阻塞、运行状态收敛、取消领取。
 *
 * 预算算术严格对齐 budget.ts 语义(在 MutableRunState 的字段上就地复算):
 * - 领取(freezeFrontierAndClaim):预留从 nodeReservations 弹出,聚合
 *   reservedTokens 保持不变——执行期间预留仍占用(= budget.claimReservation)。
 * - 成功提交:reservedTokens -= reserved;committed = min(max(actual,0),reserved);
 *   committedTokens += committed(= budget.commitSuccess,未用部分隐式释放)。
 * - 失败/无效/异常提交:reservedTokens -= reserved;committedTokens += reserved
 *   (= budget.commitFull,整笔转为已提交)。
 * - 取消/阻塞释放:reservedTokens -= reserved;committedTokens 不变
 *   (= budget.release)。
 *
 * 确定性:无 Date/random;id 经 deriveControllerId;前沿按 (-priority, nodeId)
 * 稳定排序;提案按固定序 spawn → message → skip 处理。归并幂等。记录不可变:
 * 一律经 graph-models 工厂替换整条记录,绝不原地改字段。
 */

import {
  NodeStatus,
  createAgentInput,
  type AgentInput,
  type AgentResult,
} from "@graph-agent/core";
import type {
  MessageProposal,
  SkipContextProposal,
  SpawnProposal,
} from "@graph-agent/core";
import { deriveControllerId } from "./ids.js";
import {
  EdgeType,
  ExecutionState,
  NodeState,
  RunStatus,
  createExecutionRecord,
  createNodeRecord,
  type ExecutionRecord,
  type NodeRecord,
  type ProposalDecision,
} from "./graph-models.js";
import type { MutableRunState } from "./mutable-state.js";
import type { ControllerEventType } from "./controller-events.js";
import { validateResult } from "./validation.js";
import { applyMessage, applySkip, applySpawn } from "./mutations.js";
import {
  archivedOutputOf,
  assembleContext,
  trustOf,
  type Delivery,
} from "./delivery.js";
import type { NodeFactory } from "./runner.js";

/** 控制器供给的事件追加回调,保持调度器与事件日志存储解耦。 */
type AppendEvent = (type: ControllerEventType, detail: object) => void;

/** 一次领取的执行契约:待执行的节点、其执行记录、运行器与输入。 */
export interface Claim {
  readonly node: NodeRecord;
  readonly execution: ExecutionRecord;
  readonly runner: unknown;
  readonly input: AgentInput;
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** 以给定新状态替换一条 NodeRecord(经工厂,保持不可变)。 */
function withNodeState(node: NodeRecord, state: NodeState): NodeRecord {
  return createNodeRecord({
    nodeId: node.nodeId,
    name: node.name,
    role: node.role,
    parentNodeId: node.parentNodeId,
    generation: node.generation,
    priority: node.priority,
    state,
    allowedToolNames: node.allowedToolNames,
    allocationTokens: node.allocationTokens,
  });
}

/** 以给定新状态/已提交令牌替换一条 ExecutionRecord(经工厂,保持不可变)。 */
function withExecution(
  execution: ExecutionRecord,
  state: ExecutionState,
  committedTokens: number,
): ExecutionRecord {
  return createExecutionRecord({
    executionId: execution.executionId,
    nodeId: execution.nodeId,
    sequence: execution.sequence,
    state,
    reservedTokens: execution.reservedTokens,
    committedTokens,
    eventChainHead: execution.eventChainHead,
  });
}

/** node 的所有 DEPENDS_ON 源节点 id(边 target===node 且 type===DEPENDS_ON)。 */
function dependsOnSources(state: MutableRunState, nodeId: string): string[] {
  const sources: string[] = [];
  for (const edge of state.edges) {
    if (edge.targetNodeId === nodeId && edge.type === EdgeType.DEPENDS_ON) {
      sources.push(edge.sourceNodeId);
    }
  }
  return sources;
}

/**
 * 把三类投递注入节点 input,在它开跑之前、且仍持锁时执行。
 *
 * 三个来源:
 *   (i)   pendingDeliveries —— applyMessage/applySkip 缓冲的明文;
 *   (ii)  depends_on 源的**实际产出** —— 这把依赖边从纯屏障变成数据流边,
 *         从而零调度器重构地提供真实 fan-in(父节点派生 N 个 worker 外加一个
 *         带 depends_on 边的 reducer 子节点)。在此之前完全没有子→父信息流:
 *         子节点结果只进 archivedResults 供 checkpoint,父节点早已跑完。
 *   (iii) 指向本节点的 skip_context 边 —— 祖先产出按边 weight(= contextGate)门控。
 *
 * 为什么 (iii) 要在此处再扫一遍边,而不只依赖 applySkip 的缓冲:applySkip 执行时
 * 祖先可能尚未归档产出(例如 resume 后、或祖先与接收方同一 superstep 结算),
 * 此处按边重新取一次,使跳连在产出可得时仍能生效。两条路径产生同一 edgeId,
 * 由 dedupe 去重。
 *
 * 写回 `state.inputs` 而非只传给 claim:v2 resumable 切片序列化 inputs,故
 * 投递效果随 checkpoint 一起持久化,resume 后节点看到的上下文与中断前一致。
 * 缓冲随即清空——投递是一次性的,不应在后续 superstep 重复注入。
 */
function injectDeliveries(state: MutableRunState, nodeId: string): AgentInput {
  const base = state.inputs.get(nodeId) as AgentInput;
  const candidates: Delivery[] = [...(state.pendingDeliveries.get(nodeId) ?? [])];

  for (const edge of state.edges) {
    if (edge.targetNodeId !== nodeId) {
      continue;
    }
    if (edge.type !== EdgeType.DEPENDS_ON && edge.type !== EdgeType.SKIP_CONTEXT) {
      continue;
    }
    const output = archivedOutputOf(state, edge.sourceNodeId);
    if (output === null) {
      continue;
    }
    const source = state.nodes.get(edge.sourceNodeId);
    candidates.push({
      sourceNodeId: edge.sourceNodeId,
      content: output,
      priority: source?.priority ?? 0.5,
      trust: trustOf(state, edge.sourceNodeId),
      kind: edge.type,
      edgeId: edge.edgeId,
      // depends_on 边的 weight 默认 0.5,但依赖产出是**刚性数据流**而非可选证据,
      // 不应被默认门控衰减;故 depends_on 固定 gate=1,只有 skip 用边上的 weight。
      gate: edge.type === EdgeType.DEPENDS_ON ? 1 : edge.weight,
      // 声明式数据流不受相关性否决,见 delivery.Delivery.mandatory。
      mandatory: edge.type === EdgeType.DEPENDS_ON,
    });
  }

  state.pendingDeliveries.delete(nodeId);
  if (candidates.length === 0) {
    return base;
  }

  // 同一 edgeId 可能从缓冲与边扫描各来一次;保留先出现的那条。
  const seen = new Set<string>();
  const deduped: Delivery[] = [];
  for (const d of candidates) {
    if (seen.has(d.edgeId)) {
      continue;
    }
    seen.add(d.edgeId);
    deduped.push(d);
  }

  const packets = assembleContext(deduped, base.task, state.policy);
  if (packets.length === 0) {
    return base;
  }
  const merged = createAgentInput({
    task: base.task,
    context: [...base.context, ...packets],
    sessionId: base.sessionId,
    metadata: { ...base.metadata },
  });
  state.inputs.set(nodeId, merged);
  return merged;
}

// ── freezeFrontierAndClaim ───────────────────────────────────────────────────

/**
 * 冻结当前前沿并为每个可运行节点领取一个 RUNNING 执行(调用方须持锁)。
 *
 * 前沿 = state===READY 且所有 DEPENDS_ON 源节点均为 SUCCEEDED 的节点(无
 * depends_on 边者天然满足)。按 (-priority, nodeId) 稳定排序:优先级高者在前,
 * 同优先级按 nodeId 升序。预留缺失或 <1 的节点直接置 FAILED 并跳过(不领取)。
 * 每个领取:派生 executionId,建 RUNNING 执行(reserved=预留),节点置 RUNNING;
 * 预留从 map 弹出而聚合 reservedTokens 不减(执行期间仍占用)。最后 superstep++。
 */
export function freezeFrontierAndClaim(state: MutableRunState): Claim[] {
  const frontier: NodeRecord[] = [];
  for (const node of state.nodes.values()) {
    if (node.state !== NodeState.READY) {
      continue;
    }
    const sources = dependsOnSources(state, node.nodeId);
    const satisfied = sources.every(
      (sourceId) => state.nodes.get(sourceId)?.state === NodeState.SUCCEEDED,
    );
    if (satisfied) {
      frontier.push(node);
    }
  }

  frontier.sort((a, b) => {
    if (a.priority !== b.priority) {
      return b.priority - a.priority; // -priority: higher first
    }
    return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
  });

  const claims: Claim[] = [];
  for (const node of frontier) {
    const reservation = state.nodeReservations.get(node.nodeId);
    if (reservation === undefined || reservation < 1) {
      state.nodes.set(node.nodeId, withNodeState(node, NodeState.FAILED));
      state.nodeReservations.delete(node.nodeId);
      continue;
    }

    const executionId = deriveControllerId(
      "exec",
      state.runId,
      node.nodeId,
      state.enqueueSequence,
    );
    const execution = createExecutionRecord({
      executionId,
      nodeId: node.nodeId,
      sequence: state.enqueueSequence,
      state: ExecutionState.RUNNING,
      reservedTokens: reservation,
    });
    state.executions.set(executionId, execution);
    state.enqueueSequence += 1;
    // 预留从 map 弹出;聚合 reservedTokens 保持不变(claimReservation 语义)。
    state.nodeReservations.delete(node.nodeId);

    const runningNode = withNodeState(node, NodeState.RUNNING);
    state.nodes.set(node.nodeId, runningNode);

    // 在节点真正开跑之前把投递注入其 input(详见 injectDeliveries)。
    const input = injectDeliveries(state, node.nodeId);

    claims.push({
      node: runningNode,
      execution,
      runner: state.runners.get(node.nodeId),
      input,
    });
  }

  state.superstep += 1;
  return claims;
}

// ── ingestLocked ─────────────────────────────────────────────────────────────

/**
 * 归并一条已完成执行的结果(调用方须持锁)。幂等:同一 executionId 二次归并直接
 * 返回首次存下的决策。
 *
 * 校验失败(validateResult 返回非 null)或用量超预留 → fail-closed:整笔预留转为
 * 已提交(commitFull),节点/执行置 FAILED,不采纳任何提案,记录空决策。否则按
 * status 提交:COMPLETED → 提交 min(actual,reserved) 并释放余量、置 SUCCEEDED,
 * 再按固定序 spawn→message→skip 物化提案并收集决策;FAILED → 整笔提交、置
 * FAILED。始终追加一条 execution_settled 事件。
 */
export function ingestLocked(
  state: MutableRunState,
  execution: ExecutionRecord,
  node: NodeRecord,
  result: AgentResult,
  appendEvent: AppendEvent,
  factory?: NodeFactory,
): readonly ProposalDecision[] {
  const stored = state.processedResults.get(execution.executionId);
  if (stored !== undefined) {
    return stored;
  }

  // 归档本次结算的真实 AgentResult(键 = executionId)。此点位于幂等短路之后、
  // 所有结算分支(fail-closed 非法结果、COMPLETED、FAILED)之前——它们都持有真实
  // 的 result 对象。settleException(runner 抛异常,无 result)不经此路径,故不归档。
  // 纯增:不影响预算/决策/事件逻辑,snapshotOf 也不读它。
  state.archivedResults.set(execution.executionId, result);

  const failClosed = (code: string): readonly ProposalDecision[] => {
    // commitFull: reserved -= reserved; committed += reserved.
    state.reservedTokens -= execution.reservedTokens;
    state.committedTokens += execution.reservedTokens;
    state.nodes.set(node.nodeId, withNodeState(node, NodeState.FAILED));
    state.executions.set(
      execution.executionId,
      withExecution(execution, ExecutionState.FAILED, execution.reservedTokens),
    );
    state.processedResults.set(execution.executionId, []);
    appendEvent("execution_settled", {
      nodeId: node.nodeId,
      state: "failed",
      code,
    });
    return [];
  };

  const errorCode = validateResult(result, node.nodeId, state.policy);
  if (errorCode !== null) {
    return failClosed(errorCode);
  }

  const actual = result.usage.inputTokens + result.usage.outputTokens;
  if (actual > execution.reservedTokens) {
    return failClosed("USAGE_EXCEEDS_RESERVATION");
  }

  // Commit path. Release the aggregate reservation first.
  state.reservedTokens -= execution.reservedTokens;

  if (result.status === NodeStatus.COMPLETED) {
    // commitSuccess: committed = min(max(actual,0), reserved).
    const committed = Math.min(Math.max(actual, 0), execution.reservedTokens);
    state.committedTokens += committed;
    state.nodes.set(node.nodeId, withNodeState(node, NodeState.SUCCEEDED));
    state.executions.set(
      execution.executionId,
      withExecution(execution, ExecutionState.SUCCEEDED, committed),
    );

    // Fixed proposal order: ALL spawns, THEN all messages, THEN all skips.
    const decisions: ProposalDecision[] = [];
    const spawns = result.spawnProposals as readonly SpawnProposal[];
    const messages = result.messageProposals as readonly MessageProposal[];
    const skips = result.skipContextProposals as readonly SkipContextProposal[];

    spawns.forEach((proposal, ordinal) => {
      decisions.push(
        applySpawn(state, node, proposal, ordinal, factory as NodeFactory, state.runId),
      );
    });
    for (const proposal of messages) {
      decisions.push(applyMessage(state, node, proposal, state.runId));
    }
    for (const proposal of skips) {
      decisions.push(applySkip(state, node, proposal, state.runId));
    }

    for (const decision of decisions) {
      state.decisions.push(decision);
    }

    appendEvent("execution_settled", {
      nodeId: node.nodeId,
      state: "succeeded",
      committedTokens: committed,
    });
    state.processedResults.set(execution.executionId, decisions);
    return decisions;
  }

  // status === FAILED: commit the full reservation.
  const committed = execution.reservedTokens;
  state.committedTokens += committed;
  state.nodes.set(node.nodeId, withNodeState(node, NodeState.FAILED));
  state.executions.set(
    execution.executionId,
    withExecution(execution, ExecutionState.FAILED, committed),
  );
  appendEvent("execution_settled", {
    nodeId: node.nodeId,
    state: "failed",
    committedTokens: committed,
  });
  state.processedResults.set(execution.executionId, []);
  return [];
}

// ── settleException ──────────────────────────────────────────────────────────

/**
 * 结算一次抛出异常的执行(调用方须持锁):整笔预留转为已提交(commitFull),
 * 节点/执行置 FAILED,code 取错误名(非 Error 则 UNKNOWN_ERROR)。
 */
export function settleException(
  state: MutableRunState,
  execution: ExecutionRecord,
  node: NodeRecord,
  error: unknown,
  appendEvent: AppendEvent,
): void {
  state.reservedTokens -= execution.reservedTokens;
  state.committedTokens += execution.reservedTokens;
  state.nodes.set(node.nodeId, withNodeState(node, NodeState.FAILED));
  state.executions.set(
    execution.executionId,
    withExecution(execution, ExecutionState.FAILED, execution.reservedTokens),
  );
  const code = error instanceof Error ? error.name : "UNKNOWN_ERROR";
  state.processedResults.set(execution.executionId, []);
  appendEvent("execution_settled", {
    nodeId: node.nodeId,
    state: "failed",
    code,
  });
}

// ── blockFailedDependents ────────────────────────────────────────────────────

/**
 * 定点迭代(fixpoint):任一 READY 节点若其某个 DEPENDS_ON 源处于
 * FAILED/CANCELLED/BLOCKED,则置该节点 BLOCKED 并释放其预留(仅释放,不提交)。
 * 反复直到无变化,以传播级联阻塞。
 */
export function blockFailedDependents(state: MutableRunState): void {
  const adverse: ReadonlySet<NodeState> = new Set([
    NodeState.FAILED,
    NodeState.CANCELLED,
    NodeState.BLOCKED,
  ]);

  let changed = true;
  while (changed) {
    changed = false;
    for (const node of state.nodes.values()) {
      if (node.state !== NodeState.READY) {
        continue;
      }
      const sources = dependsOnSources(state, node.nodeId);
      const blocked = sources.some((sourceId) =>
        adverse.has(state.nodes.get(sourceId)?.state as NodeState),
      );
      if (!blocked) {
        continue;
      }
      state.nodes.set(node.nodeId, withNodeState(node, NodeState.BLOCKED));
      const reservation = state.nodeReservations.get(node.nodeId);
      if (reservation !== undefined) {
        state.nodeReservations.delete(node.nodeId);
        state.reservedTokens -= reservation; // release, NOT commit
      }
      changed = true;
    }
  }
}

// ── settleRun ────────────────────────────────────────────────────────────────

/**
 * 依优先级收敛运行状态(调用方须持锁):任一节点 READY|RUNNING → RUNNING;
 * 否则任一 CANCELLED → CANCELLED;否则任一 FAILED|BLOCKED → FAILED;否则 SUCCEEDED。
 */
export function settleRun(state: MutableRunState): void {
  let hasActive = false;
  let hasCancelled = false;
  let hasFailedOrBlocked = false;
  for (const node of state.nodes.values()) {
    if (node.state === NodeState.READY || node.state === NodeState.RUNNING) {
      hasActive = true;
    } else if (node.state === NodeState.CANCELLED) {
      hasCancelled = true;
    } else if (node.state === NodeState.FAILED || node.state === NodeState.BLOCKED) {
      hasFailedOrBlocked = true;
    }
  }

  if (hasActive) {
    state.status = RunStatus.RUNNING;
  } else if (hasCancelled) {
    state.status = RunStatus.CANCELLED;
  } else if (hasFailedOrBlocked) {
    state.status = RunStatus.FAILED;
  } else {
    state.status = RunStatus.SUCCEEDED;
  }
}

// ── cancelClaims ─────────────────────────────────────────────────────────────

/**
 * 取消一批领取(调用方须持锁):仍 RUNNING 的执行释放其预留(仅释放,不提交),
 * 节点/执行置 CANCELLED;此外任一仍 READY 的节点弹出其预留并释放、置 CANCELLED。
 * 最终运行状态置 CANCELLED。
 */
export function cancelClaims(state: MutableRunState, claims: Claim[]): void {
  for (const claim of claims) {
    const execution = state.executions.get(claim.execution.executionId);
    if (execution === undefined || execution.state !== ExecutionState.RUNNING) {
      continue;
    }
    state.reservedTokens -= execution.reservedTokens; // release, NOT commit
    state.executions.set(
      execution.executionId,
      withExecution(execution, ExecutionState.CANCELLED, 0),
    );
    const node = state.nodes.get(execution.nodeId);
    if (node !== undefined) {
      state.nodes.set(node.nodeId, withNodeState(node, NodeState.CANCELLED));
    }
  }

  for (const node of state.nodes.values()) {
    if (node.state !== NodeState.READY) {
      continue;
    }
    const reservation = state.nodeReservations.get(node.nodeId);
    if (reservation !== undefined) {
      state.nodeReservations.delete(node.nodeId);
      state.reservedTokens -= reservation; // release, NOT commit
    }
    state.nodes.set(node.nodeId, withNodeState(node, NodeState.CANCELLED));
  }

  state.status = RunStatus.CANCELLED;
}
