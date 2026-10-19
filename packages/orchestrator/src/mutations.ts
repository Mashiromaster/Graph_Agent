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
  const identity = createAgentIdentity({
    nodeId: childId,
    name: agentName(proposal.role),
    role: proposal.role,
    generation: proposal.generation,
    parentNodeId: parent.nodeId,
  });
  const budget = createNodeBudget({ maxTotalTokens: allocation });
  // modelKind 已由 validateSpawn 对照 policy.allowedModelKinds 校验;条件展开
  // 保证未指定时键不存在,spec 的 canonicalJson 与既有行为一致。
  const spec = {
    identity,
    budget,
    role: proposal.role,
    ...(proposal.modelKind !== undefined ? { modelKind: proposal.modelKind } : {}),
  };
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
    modelKind: proposal.modelKind ?? null,
  });
  const input: AgentInput = createAgentInput({
    task: proposal.objective,
    context: [
      createContextPacket({
        sourceNodeId: parent.nodeId,
        content: proposal.instructions,
        trust: identity.trustScore,
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

  const edgeId = deriveControllerId(
    "skip",
    runId,
    proposal.sourceNodeId,
    requester.nodeId,
    proposal.proposalId,
  );
  state.edges.push(
    createEdgeRecord({
      edgeId,
      sourceNodeId: proposal.sourceNodeId,
      targetNodeId: requester.nodeId,
      type: EdgeType.SKIP_CONTEXT,
      weight: proposal.contextGate,
      contentHash: sha256(proposal.reason),
    }),
  );

  return accept(proposal.proposalId, "skip", requester.nodeId, edgeId);
}
