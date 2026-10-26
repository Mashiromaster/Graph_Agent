/**
 * 图变更:在控制器临界区内物化提案为节点/边。
 *
 * 三个函数(applySpawn/applyMessage/applySkip)直接修改传入的
 * `MutableRunState`——这是控制器持有的私有可变状态,允许原地增删其集合/标量。
 * 但放入 Map/数组的记录本身仍不可变:一律经 graph-models 工厂产出冻结记录。
 *
 * 每个函数返回一份 `ProposalDecision`(ACCEPTED 或 REJECTED)。校验委托给
 * validation.ts 的 validateSpawn/validateMessage/validateSkip;通过后再执行
 * 物化专属的门槛检查(重复 id、全局预算)。确定性:无 Date/random,id 经
 * deriveControllerId 派生,内容哈希经 core sha256。
 */

import { sha256 } from "@graph-agent/core";
import type {
  AgentInput,
  MessageProposal,
  SkipContextProposal,
  SpawnProposal,
} from "@graph-agent/core";
import {
  createAgentIdentity,
  createAgentInput,
  createContextPacket,
  createNodeBudget,
} from "@graph-agent/core";
import { deriveControllerId } from "./ids.js";
import {
  EdgeType,
  NodeState,
  DecisionState,
  createEdgeRecord,
  createNodeRecord,
  createProposalDecision,
  type NodeRecord,
  type ProposalDecision,
} from "./graph-models.js";
import type { MutableRunState } from "./mutable-state.js";
import { archivedOutputOf, bufferDelivery, trustOf } from "./delivery.js";
import { trustForRole } from "./trust.js";
import { validateMessage, validateSkip, validateSpawn } from "./validation.js";
import type { NodeFactory } from "./runner.js";

/** Build a REJECTED decision with the given proposal metadata. */
function reject(
  proposalId: string,
  proposalType: string,
  sourceNodeId: string,
  code: string,
  message: string,
): ProposalDecision {
  return createProposalDecision({
    proposalId,
    proposalType,
    sourceNodeId,
    state: DecisionState.REJECTED,
    code,
    message,
    materializedId: null,
  });
}

/** Build an ACCEPTED decision carrying the materialized entity id. */
function accept(
  proposalId: string,
  proposalType: string,
  sourceNodeId: string,
  materializedId: string,
): ProposalDecision {
  return createProposalDecision({
    proposalId,
    proposalType,
    sourceNodeId,
    state: DecisionState.ACCEPTED,
    code: "OK",
    message: "",
    materializedId,
  });
}

/** Title-case a role for the child agent's display name, e.g. "worker" → "Worker Agent". */
function agentName(role: string): string {
  const trimmed = role.trim();
  const titled = trimmed.length > 0 ? trimmed[0]!.toUpperCase() + trimmed.slice(1) : role;
  return `${titled} Agent`;
}

/**
 * Materialize a {@link SpawnProposal} into a READY child node, its spec/runner/
 * input, a budget reservation, and a SPAWN edge. Mutates {@link state} in place.
 */
export function applySpawn(
  state: MutableRunState,
  parent: NodeRecord,
  proposal: SpawnProposal,
  ordinal: number,
  factory: NodeFactory,
  runId: string,
): ProposalDecision {
  const view = { nodes: state.nodes, edges: state.edges };

  // 1. Structural + field validation (delegated).
  const failure = validateSpawn(proposal, parent, view, state.policy);
  if (failure !== null) {
    return reject(proposal.proposalId, "spawn", parent.nodeId, failure.code, failure.message);
  }

  // 2. Deterministic child id; duplicate guard.
  const childId = deriveControllerId(
    "node",
    runId,
    parent.nodeId,
    ordinal,
    proposal.proposalId,
  );
  if (state.nodes.has(childId)) {
    return reject(
      proposal.proposalId,
      "spawn",
      parent.nodeId,
      "DUPLICATE_PROPOSAL",
      "child id already materialized",
    );
  }

  // 3. Allocation from parent share, floored to >= 1.
  const allocation = Math.max(
    1,
    Math.floor(parent.allocationTokens * proposal.budgetShare),
  );

  // 4. Global budget gate.
  const available =
    state.policy.maxTotalTokens - state.committedTokens - state.reservedTokens;
  if (allocation > available) {
    return reject(
      proposal.proposalId,
      "spawn",
      parent.nodeId,
      "TOKEN_BUDGET_EXHAUSTED",
      "allocation exceeds available budget",
    );
  }

  // 5. Tool subset already enforced by validateSpawn (PERMISSION_ESCALATION).
  const toolNames = proposal.toolNames;

  // 6. Build the child spec + runner inside try/catch → FACTORY_ERROR on throw.
  //
  // 子节点的 trustScore 取自**按角色键的跨运行可信度表**(state.trustTable),而
  // 非父节点的 trust。原因见 trust.ts 文件头:节点只执行一次且永不重入,运行内的
  // 节点级 trust 学习由构造不可能,可学习的只有跨运行的角色级可信度。表缺失时
  // trustForRole 回退到 1(无罪推定),与此前的行为一致。
  const identity = createAgentIdentity({
    nodeId: childId,
    name: agentName(proposal.role),
    role: proposal.role,
    generation: proposal.generation,
    parentNodeId: parent.nodeId,
    trustScore: trustForRole(state.trustTable, proposal.role),
  });
  const budget = createNodeBudget({ maxTotalTokens: allocation });
  const spec = { identity, budget, role: proposal.role };
  let runner;
  try {
    runner = factory.create({ spec, toolNames });
  } catch {
    return reject(
      proposal.proposalId,
      "spawn",
      parent.nodeId,
      "FACTORY_ERROR",
      "node factory failed to create runner",
    );
  }

  // 7. Materialize. Records are frozen via factories; only the state containers mutate.
  const child = createNodeRecord({
    nodeId: childId,
    name: agentName(proposal.role),
    role: proposal.role,
    parentNodeId: parent.nodeId,
    generation: proposal.generation,
    priority: proposal.priority,
    state: NodeState.READY,
    allowedToolNames: toolNames,
    allocationTokens: allocation,
  });
  // spawn 上下文携带**父节点给出的指令**,而非父节点的完整产出。
  //
  // Python 实现(controller.py:554)传的是 `result.output`,两者曾长期分歧。这里
  // 确定采用 instructions,理由是职责分离而非实现便利:
  //   - instructions 是父节点**针对该子节点**裁剪过的任务说明,精准且短;
  //   - 完整产出若需要传递,现在有专门通道——`depends_on` 数据流边(见
  //     scheduler.injectDeliveries),它受 token 预算与可信度门控约束;
  //   - 把完整产出无条件塞进每个子节点,会让上下文随扇出线性膨胀,正是调研
  //     §15.2「上下文爆炸」要避免的。
  // 两条通道各司其职后,instructions 是正确的 spawn 语义。
  //
  // trust 取**父节点**的可信度:内容来自父节点,故可信度也应是父节点的。此前
  // 误用了子节点 identity 的 trustScore——在 trust 全为 1 时无差别,但角色级
  // 可信度生效后会把子节点的先验错当成这段内容的可信度。
  const input: AgentInput = createAgentInput({
    task: proposal.objective,
    context: [
      createContextPacket({
        sourceNodeId: parent.nodeId,
        content: proposal.instructions,
        trust: trustOf(state, parent.nodeId),
        edgeType: EdgeType.SPAWN,
      }),
    ],
    sessionId: childId,
  });

  state.nodes.set(childId, child);
  state.specs.set(childId, spec);
  state.runners.set(childId, runner);
  state.inputs.set(childId, input);
  state.nodeReservations.set(childId, allocation);
  state.reservedTokens += allocation;
  state.edges.push(
    createEdgeRecord({
      edgeId: deriveControllerId("edge", runId, parent.nodeId, childId, "spawn"),
      sourceNodeId: parent.nodeId,
      targetNodeId: childId,
      type: EdgeType.SPAWN,
      priority: proposal.priority,
      weight: proposal.budgetShare,
    }),
  );

  return accept(proposal.proposalId, "spawn", parent.nodeId, childId);
}

/**
 * Materialize a {@link MessageProposal} into a MESSAGE edge from source to
 * target. Mutates {@link state.edges} in place.
 */
export function applyMessage(
  state: MutableRunState,
  source: NodeRecord,
  proposal: MessageProposal,
  runId: string,
): ProposalDecision {
  const view = { nodes: state.nodes, edges: state.edges };
  const failure = validateMessage(proposal, source, view, state.policy);
  if (failure !== null) {
    return reject(
      proposal.proposalId,
      "message",
      source.nodeId,
      failure.code,
      failure.message,
    );
  }

  // 目标必须尚未运行才能收到投递:节点只执行一次且永不重入,故向已 RUNNING 或
  // 已终态的节点发消息不可能影响任何输出。此前这种提案被静默接受并记录一条惰性
  // 边,使「通讯」看似发生、实则无效——显式拒绝,让无效通讯在 decisions 里可见。
  const target = state.nodes.get(proposal.targetNodeId);
  if (target === undefined || target.state !== NodeState.READY) {
    return reject(
      proposal.proposalId,
      "message",
      source.nodeId,
      "TARGET_ALREADY_EXECUTED",
      "message target is not READY; it cannot receive context",
    );
  }

  const edgeId = deriveControllerId(
    "message",
    runId,
    source.nodeId,
    proposal.targetNodeId,
    proposal.proposalId,
  );
  state.edges.push(
    createEdgeRecord({
      edgeId,
      sourceNodeId: source.nodeId,
      targetNodeId: proposal.targetNodeId,
      type: EdgeType.MESSAGE,
      priority: proposal.priority,
      ttlSeconds: proposal.ttlSeconds,
      contentHash: sha256(proposal.content),
    }),
  );

  // 明文入缓冲(不进快照);边上仍只留 contentHash,审计口径不变。
  bufferDelivery(state, proposal.targetNodeId, {
    sourceNodeId: source.nodeId,
    content: proposal.content,
    priority: proposal.priority,
    trust: trustOf(state, source.nodeId),
    kind: EdgeType.MESSAGE,
    edgeId,
    gate: 1,
    mandatory: false, // 显式消息是可裁量证据,交由路由筛选
  });

  return accept(proposal.proposalId, "message", source.nodeId, edgeId);
}

/**
 * Materialize a {@link SkipContextProposal} into a SKIP_CONTEXT edge from the
 * ancestor source to the requester. Mutates {@link state.edges} in place.
 */
export function applySkip(
  state: MutableRunState,
  requester: NodeRecord,
  proposal: SkipContextProposal,
  runId: string,
): ProposalDecision {
  const view = { nodes: state.nodes, edges: state.edges };
  const failure = validateSkip(proposal, requester, view, state.policy);
  if (failure !== null) {
    return reject(
      proposal.proposalId,
      "skip",
      requester.nodeId,
      failure.code,
      failure.message,
    );
  }

  // 实际接收方取自提案(可能是提案者自身,也可能是它刚派生的子节点),
  // 而非提案者本身——后者按定义已跑完,指向它的边必然惰性。
  const recipientId = proposal.requesterNodeId;
  const edgeId = deriveControllerId(
    "skip",
    runId,
    proposal.sourceNodeId,
    recipientId,
    proposal.proposalId,
  );
  state.edges.push(
    createEdgeRecord({
      edgeId,
      sourceNodeId: proposal.sourceNodeId,
      targetNodeId: recipientId,
      type: EdgeType.SKIP_CONTEXT,
      weight: proposal.contextGate,
      contentHash: sha256(proposal.reason),
    }),
  );

  // 跳连投递的内容是**祖先的实际产出**(从归档结果取),而非提案里的 reason——
  // reason 只是请求理由,把它当内容投递就只是把提案者自己的话回灌给接收方。
  // 祖先尚无归档产出(例如它失败了)时不投递,只留边以供审计。
  const ancestorOutput = archivedOutputOf(state, proposal.sourceNodeId);
  if (ancestorOutput !== null) {
    bufferDelivery(state, recipientId, {
      sourceNodeId: proposal.sourceNodeId,
      content: ancestorOutput,
      priority: state.nodes.get(proposal.sourceNodeId)?.priority ?? 0.5,
      trust: trustOf(state, proposal.sourceNodeId),
      kind: EdgeType.SKIP_CONTEXT,
      edgeId,
      gate: proposal.contextGate,
      mandatory: false, // 跨代跳连是可裁量证据
    });
  }

  return accept(proposal.proposalId, "skip", recipientId, edgeId);
}
