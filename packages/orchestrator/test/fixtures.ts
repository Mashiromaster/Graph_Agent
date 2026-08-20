import {
  EventRecorder,
  EventType,
  NodeStatus,
  createAgentInput,
  createAgentResult,
  createSpawnProposal,
  createUsage,
  resultBindingHash,
  type AgentInput,
  type AgentResult,
  type SpawnProposal,
} from "@graph-agent/core";

/**
 * Build a genuine COMPLETED AgentResult with a real event chain + result binding
 * hash (mirrors the fixture pattern in scheduler.test.ts / validate-result.test).
 */
export function completedResult(
  nodeId: string,
  inputTokens: number,
  outputTokens: number,
  spawnProposals: readonly SpawnProposal[] = [],
): AgentResult {
  const output = "done";
  const resultHash = resultBindingHash({
    nodeId,
    status: NodeStatus.COMPLETED,
    output,
    inputTokens,
    outputTokens,
    spawnProposals: spawnProposals as never,
    messageProposals: [] as never,
    skipContextProposals: [] as never,
  });
  const recorder = new EventRecorder(nodeId, () => 0);
  recorder.record({ type: EventType.NODE_STARTED });
  recorder.record({ type: EventType.NODE_COMPLETED, metadata: { result_hash: resultHash } });
  return createAgentResult({
    nodeId,
    status: NodeStatus.COMPLETED,
    output,
    usage: createUsage({ inputTokens, outputTokens }),
    events: recorder.events,
    spawnProposals: spawnProposals as never,
    messageProposals: [] as never,
    skipContextProposals: [] as never,
  });
}

/** A structurally-broken result: right shape, WRONG nodeId → SOURCE_MISMATCH. */
export function wrongNodeResult(claimedNodeId: string, actualNodeId: string): AgentResult {
  // Build a genuine result for `actualNodeId` then hand it to a node expecting
  // `claimedNodeId`; validateResult's nodeId check trips SOURCE_MISMATCH.
  void claimedNodeId;
  return completedResult(actualNodeId, 5, 5);
}

/** Build a spawn proposal for a gen-(parentGen+1) child under `parentNodeId`. */
export function spawnProposal(
  proposalId: string,
  parentNodeId: string,
  parentGeneration: number,
  toolNames: readonly string[],
  budgetShare = 0.5,
  priority = 0.5,
): SpawnProposal {
  return createSpawnProposal({
    proposalId,
    parentNodeId,
    generation: parentGeneration + 1,
    role: "worker",
    objective: "sub objective",
    instructions: "do the work",
    toolNames: [...toolNames],
    priority,
    budgetShare,
  });
}

export function agentInput(nodeId: string): AgentInput {
  return createAgentInput({ task: "task", context: [], sessionId: nodeId });
}
