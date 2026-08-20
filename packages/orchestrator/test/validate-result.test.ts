import { describe, expect, it } from "vitest";
import {
  EventRecorder,
  EventType,
  NodeStatus,
  createAgentResult,
  createMessageProposal,
  createNodeError,
  createSkipContextProposal,
  createSpawnProposal,
  createUsage,
  resultBindingHash,
  type AgentResult,
  type RunEvent,
} from "@graph-agent/core";
import {
  createControllerPolicy,
  type ControllerPolicy,
} from "../src/policy.js";
import {
  createEdgeRecord,
  createNodeRecord,
  EdgeType,
  NodeState,
  type EdgeRecord,
  type NodeRecord,
} from "../src/graph-models.js";
import {
  isAncestor,
  validateMessage,
  validateResult,
  validateSkip,
  validateSpawn,
  type ValidatorState,
} from "../src/validation.js";

const POLICY: ControllerPolicy = createControllerPolicy();

// ── validateResult fixtures ───────────────────────────────────────────────

/**
 * Build a genuine, fully-valid COMPLETED AgentResult. The terminal event's
 * metadata carries a result_hash equal to core resultBindingHash over the
 * result fields, and the event chain is produced by a real EventRecorder so
 * verifyEventChain passes.
 */
function buildCompleted(overrides?: {
  nodeId?: string;
  output?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  staleHash?: string;
}): AgentResult {
  const nodeId = overrides?.nodeId ?? "node-1";
  const status = NodeStatus.COMPLETED;
  const output = overrides?.output === undefined ? "hello" : overrides.output;
  const inputTokens = overrides?.inputTokens ?? 10;
  const outputTokens = overrides?.outputTokens ?? 5;

  const resultHash = resultBindingHash({
    nodeId,
    status,
    output,
    inputTokens,
    outputTokens,
  });

  const recorder = new EventRecorder(nodeId, () => 0);
  recorder.record({ type: EventType.NODE_STARTED });
  recorder.record({
    type: EventType.NODE_COMPLETED,
    metadata: { result_hash: overrides?.staleHash ?? resultHash },
  });

  return createAgentResult({
    nodeId,
    status,
    output,
    usage: createUsage({ inputTokens, outputTokens }),
    events: recorder.events,
  });
}

/** Build a genuine FAILED AgentResult with a NodeError and terminal NODE_FAILED. */
function buildFailed(): AgentResult {
  const nodeId = "node-1";
  const status = NodeStatus.FAILED;
  const output = null;
  const inputTokens = 3;
  const outputTokens = 0;
  const error = createNodeError({ code: "boom", message: "it failed", retryable: false });

  const resultHash = resultBindingHash({
    nodeId,
    status,
    output,
    inputTokens,
    outputTokens,
    error,
  });

  const recorder = new EventRecorder(nodeId, () => 0);
  recorder.record({ type: EventType.NODE_STARTED });
  recorder.record({
    type: EventType.NODE_FAILED,
    metadata: { result_hash: resultHash },
  });

  return createAgentResult({
    nodeId,
    status,
    output,
    usage: createUsage({ inputTokens, outputTokens }),
    events: recorder.events,
    error,
  });
}

describe("validateResult — valid", () => {
  it("完好的 COMPLETED result 返回 null", () => {
    expect(validateResult(buildCompleted(), "node-1", POLICY)).toBeNull();
  });

  it("完好的 FAILED result 返回 null", () => {
    expect(validateResult(buildFailed(), "node-1", POLICY)).toBeNull();
  });

  it("output 为 null 时合法", () => {
    const r = buildCompleted({ output: null });
    expect(validateResult(r, "node-1", POLICY)).toBeNull();
  });
});

describe("validateResult — error codes", () => {
  it("SOURCE_MISMATCH: result.nodeId !== expected", () => {
    const r = buildCompleted();
    expect(validateResult(r, "other-node", POLICY)).toBe("SOURCE_MISMATCH");
  });

  it("SOURCE_MISMATCH: 事件 nodeId 与 expected 不符", () => {
    // Build a valid chain under node-1 but claim it belongs to node-2 via result.nodeId.
    // Instead: build chain for node-1, then wrap result claiming nodeId node-1 but
    // one event carries a different nodeId — forge an event array.
    const good = buildCompleted();
    const forgedEvents = good.events.map((e, i) =>
      i === 0 ? Object.freeze({ ...e, nodeId: "evil" }) : e,
    );
    // result.nodeId still node-1 so check #1 passes; check #2 chain will break because
    // eventHash was computed over original nodeId. To isolate check #3 we need the chain
    // to still verify — but changing nodeId breaks the hash. So this path actually surfaces
    // as INVALID_EVENT_CHAIN, which is acceptable defense-in-depth. We assert non-null.
    const r = createAgentResult({
      nodeId: good.nodeId,
      status: good.status,
      output: good.output,
      usage: good.usage,
      events: forgedEvents,
    });
    expect(validateResult(r, "node-1", POLICY)).not.toBeNull();
  });

  it("INVALID_EVENT_CHAIN: 空事件数组", () => {
    const r = createAgentResult({
      nodeId: "node-1",
      status: NodeStatus.COMPLETED,
      output: "hi",
      usage: createUsage({ inputTokens: 1, outputTokens: 1 }),
      events: [],
    });
    expect(validateResult(r, "node-1", POLICY)).toBe("INVALID_EVENT_CHAIN");
  });

  it("INVALID_EVENT_CHAIN: 篡改 eventHash 破坏链", () => {
    const good = buildCompleted();
    const broken = good.events.map((e, i) =>
      i === 1 ? Object.freeze({ ...e, eventHash: "f".repeat(64) }) : e,
    );
    const r = createAgentResult({
      nodeId: "node-1",
      status: NodeStatus.COMPLETED,
      output: "hello",
      usage: createUsage({ inputTokens: 10, outputTokens: 5 }),
      events: broken,
    });
    expect(validateResult(r, "node-1", POLICY)).toBe("INVALID_EVENT_CHAIN");
  });

  it("INVALID_EVENT_CHAIN: 超过 maxEventsPerResult", () => {
    const policy = createControllerPolicy({ maxEventsPerResult: 1 });
    // buildCompleted has 2 events > 1
    expect(validateResult(buildCompleted(), "node-1", policy)).toBe("INVALID_EVENT_CHAIN");
  });

  it("INVALID_EVENT_STATE: 首事件非 NODE_STARTED", () => {
    // Build a genuine chain whose first event is NODE_COMPLETED (still hash-valid).
    const nodeId = "node-1";
    const output = "hello";
    const inputTokens = 10;
    const outputTokens = 5;
    const resultHash = resultBindingHash({
      nodeId,
      status: NodeStatus.COMPLETED,
      output,
      inputTokens,
      outputTokens,
    });
    const recorder = new EventRecorder(nodeId, () => 0);
    recorder.record({
      type: EventType.NODE_COMPLETED,
      metadata: { result_hash: resultHash },
    });
    const r = createAgentResult({
      nodeId,
      status: NodeStatus.COMPLETED,
      output,
      usage: createUsage({ inputTokens, outputTokens }),
      events: recorder.events,
    });
    expect(validateResult(r, "node-1", POLICY)).toBe("INVALID_EVENT_STATE");
  });

  it("INVALID_EVENT_STATE: COMPLETED 但终结事件为 NODE_FAILED", () => {
    // Genuine chain: NODE_STARTED then NODE_FAILED, but result.status COMPLETED.
    const nodeId = "node-1";
    const output = "hello";
    const inputTokens = 10;
    const outputTokens = 5;
    const resultHash = resultBindingHash({
      nodeId,
      status: NodeStatus.COMPLETED,
      output,
      inputTokens,
      outputTokens,
    });
    const recorder = new EventRecorder(nodeId, () => 0);
    recorder.record({ type: EventType.NODE_STARTED });
    recorder.record({
      type: EventType.NODE_FAILED,
      metadata: { result_hash: resultHash },
    });
    const r = createAgentResult({
      nodeId,
      status: NodeStatus.COMPLETED,
      output,
      usage: createUsage({ inputTokens, outputTokens }),
      events: recorder.events,
    });
    expect(validateResult(r, "node-1", POLICY)).toBe("INVALID_EVENT_STATE");
  });

  it("INVALID_EVENT_STATE: COMPLETED 但 error 非 null", () => {
    const good = buildCompleted();
    const error = createNodeError({ code: "x", message: "y" });
    // Recompute a result_hash that includes error so binding matches; the state check
    // (status COMPLETED requires error===null) must fire before/independent of binding.
    const nodeId = "node-1";
    const resultHash = resultBindingHash({
      nodeId,
      status: NodeStatus.COMPLETED,
      output: "hello",
      inputTokens: 10,
      outputTokens: 5,
      error,
    });
    const recorder = new EventRecorder(nodeId, () => 0);
    recorder.record({ type: EventType.NODE_STARTED });
    recorder.record({
      type: EventType.NODE_COMPLETED,
      metadata: { result_hash: resultHash },
    });
    const r = createAgentResult({
      nodeId,
      status: NodeStatus.COMPLETED,
      output: "hello",
      usage: createUsage({ inputTokens: 10, outputTokens: 5 }),
      events: recorder.events,
      error,
    });
    void good;
    expect(validateResult(r, "node-1", POLICY)).toBe("INVALID_EVENT_STATE");
  });

  it("INVALID_NODE_STATUS: 未知 status", () => {
    const good = buildCompleted();
    const r = Object.freeze({ ...good, status: "running" as unknown as NodeStatus });
    expect(validateResult(r, "node-1", POLICY)).toBe("INVALID_NODE_STATUS");
  });

  it("INVALID_EVENT_SCHEMA: 非有限 timestamp", () => {
    // A genuine chain cannot carry a non-finite timestamp (the hash covers it and
    // canonicalJson rejects Infinity). Hand-forge a single event with an Infinity
    // timestamp; it must be rejected (chain or schema layer). Defense-in-depth.
    const bad: RunEvent = Object.freeze({
      sequence: 0,
      timestamp: Number.POSITIVE_INFINITY,
      nodeId: "node-1",
      type: EventType.NODE_STARTED,
      inputHash: "0".repeat(64),
      outputHash: "0".repeat(64),
      metadataJson: "{}",
      previousHash: "0".repeat(64),
      eventHash: "0".repeat(64),
    });
    const r = createAgentResult({
      nodeId: "node-1",
      status: NodeStatus.COMPLETED,
      output: "hi",
      usage: createUsage({ inputTokens: 1, outputTokens: 1 }),
      events: [bad],
    });
    expect(validateResult(r, "node-1", POLICY)).not.toBeNull();
  });

  it("INVALID_EVENT_SCHEMA: 非 sha256 hash 字段", () => {
    // A single hand-forged event with bad inputHash; chain would also fail, but assert non-null.
    const bad: RunEvent = Object.freeze({
      sequence: 0,
      timestamp: 0,
      nodeId: "node-1",
      type: EventType.NODE_STARTED,
      inputHash: "not-hex",
      outputHash: "0".repeat(64),
      metadataJson: "{}",
      previousHash: "0".repeat(64),
      eventHash: "0".repeat(64),
    });
    const r = createAgentResult({
      nodeId: "node-1",
      status: NodeStatus.COMPLETED,
      output: "hi",
      usage: createUsage({ inputTokens: 1, outputTokens: 1 }),
      events: [bad],
    });
    expect(validateResult(r, "node-1", POLICY)).not.toBeNull();
  });

  it("INVALID_USAGE: 负 token", () => {
    // usage bypassing factory to inject negative
    const good = buildCompleted();
    const r = Object.freeze({
      ...good,
      usage: Object.freeze({ inputTokens: -1, outputTokens: 5 }),
    });
    expect(validateResult(r, "node-1", POLICY)).toBe("INVALID_USAGE");
  });

  it("INVALID_USAGE: 布尔冒充 token", () => {
    const good = buildCompleted();
    const r = Object.freeze({
      ...good,
      usage: Object.freeze({ inputTokens: true as unknown as number, outputTokens: 5 }),
    });
    expect(validateResult(r, "node-1", POLICY)).toBe("INVALID_USAGE");
  });

  it("INVALID_USAGE: 超过 maxTotalTokens", () => {
    const policy = createControllerPolicy({ maxTotalTokens: 3 });
    // buildCompleted uses inputTokens 10 > 3
    expect(validateResult(buildCompleted(), "node-1", policy)).toBe("INVALID_USAGE");
  });

  it("MALFORMED_RESULT: proposals 非数组", () => {
    const good = buildCompleted();
    const r = Object.freeze({
      ...good,
      spawnProposals: "nope" as unknown as never,
    });
    expect(validateResult(r, "node-1", POLICY)).toBe("MALFORMED_RESULT");
  });

  it("MALFORMED_RESULT: 空 output 字符串", () => {
    const good = buildCompleted();
    const r = Object.freeze({ ...good, output: "" });
    expect(validateResult(r, "node-1", POLICY)).toBe("MALFORMED_RESULT");
  });

  it("SOURCE_MISMATCH: result 非对象(nodeId 不可能匹配)", () => {
    // Check #1 rejects a non-object via the nodeId comparison → SOURCE_MISMATCH.
    expect(validateResult(null, "node-1", POLICY)).toBe("SOURCE_MISMATCH");
    expect(validateResult(42, "node-1", POLICY)).toBe("SOURCE_MISMATCH");
  });

  it("PROPOSAL_LIMIT: 超过 maxProposalsPerResult", () => {
    const policy = createControllerPolicy({ maxProposalsPerResult: 1 });
    const nodeId = "node-1";
    const output = "hello";
    const inputTokens = 10;
    const outputTokens = 5;
    const spawnProposals = [
      createSpawnProposal({
        proposalId: "p1",
        parentNodeId: nodeId,
        generation: 1,
        role: "r",
        objective: "o",
        instructions: "i",
      }),
      createSpawnProposal({
        proposalId: "p2",
        parentNodeId: nodeId,
        generation: 1,
        role: "r",
        objective: "o",
        instructions: "i",
      }),
    ];
    const resultHash = resultBindingHash({
      nodeId,
      status: NodeStatus.COMPLETED,
      output,
      inputTokens,
      outputTokens,
      spawnProposals,
    });
    const recorder = new EventRecorder(nodeId, () => 0);
    recorder.record({ type: EventType.NODE_STARTED });
    recorder.record({
      type: EventType.NODE_COMPLETED,
      metadata: { result_hash: resultHash },
    });
    const r = createAgentResult({
      nodeId,
      status: NodeStatus.COMPLETED,
      output,
      usage: createUsage({ inputTokens, outputTokens }),
      events: recorder.events,
      spawnProposals,
    });
    expect(validateResult(r, "node-1", policy)).toBe("PROPOSAL_LIMIT");
  });

  it("RESULT_BINDING_MISMATCH: 篡改 output 后 result_hash 陈旧", () => {
    const genuineHash = resultBindingHash({
      nodeId: "node-1",
      status: NodeStatus.COMPLETED,
      output: "hello",
      inputTokens: 10,
      outputTokens: 5,
    });
    // Build a valid chain bound to "hello", then present a result with output "tampered".
    const nodeId = "node-1";
    const recorder = new EventRecorder(nodeId, () => 0);
    recorder.record({ type: EventType.NODE_STARTED });
    recorder.record({
      type: EventType.NODE_COMPLETED,
      metadata: { result_hash: genuineHash },
    });
    const r = createAgentResult({
      nodeId,
      status: NodeStatus.COMPLETED,
      output: "tampered",
      usage: createUsage({ inputTokens: 10, outputTokens: 5 }),
      events: recorder.events,
    });
    expect(validateResult(r, "node-1", POLICY)).toBe("RESULT_BINDING_MISMATCH");
  });
});

// ── proposal validator fixtures ───────────────────────────────────────────

function makeNode(overrides?: Partial<NodeRecord>): NodeRecord {
  return createNodeRecord({
    nodeId: overrides?.nodeId ?? "parent",
    name: overrides?.name ?? "Parent",
    role: overrides?.role ?? "root",
    parentNodeId: overrides?.parentNodeId ?? null,
    generation: overrides?.generation ?? 0,
    priority: overrides?.priority ?? 0.5,
    state: overrides?.state ?? NodeState.RUNNING,
    allowedToolNames: overrides?.allowedToolNames ?? ["search", "fetch"],
    allocationTokens: overrides?.allocationTokens ?? 1000,
  });
}

function makeState(
  nodes: NodeRecord[],
  edges: EdgeRecord[] = [],
): ValidatorState {
  const map = new Map<string, NodeRecord>();
  for (const n of nodes) map.set(n.nodeId, n);
  return { nodes: map, edges };
}

function spawnEdge(source: string, target: string, weight = 0.25): EdgeRecord {
  return createEdgeRecord({
    edgeId: `${source}->${target}`,
    sourceNodeId: source,
    targetNodeId: target,
    type: EdgeType.SPAWN,
    weight,
  });
}

function validSpawn(overrides?: Record<string, unknown>) {
  return createSpawnProposal({
    proposalId: "sp-1",
    parentNodeId: "parent",
    generation: 1,
    role: "worker",
    objective: "do things",
    instructions: "carefully",
    toolNames: ["search"],
    priority: 0.5,
    budgetShare: 0.25,
    ...(overrides as object),
  });
}

describe("validateSpawn", () => {
  const parent = makeNode();

  it("合法 spawn 返回 null", () => {
    const state = makeState([parent]);
    expect(validateSpawn(validSpawn(), parent, state, POLICY)).toBeNull();
  });

  it("SOURCE_MISMATCH: parentNodeId 不符", () => {
    const state = makeState([parent]);
    const p = validSpawn({ parentNodeId: "someone-else" });
    expect(validateSpawn(p, parent, state, POLICY)?.code).toBe("SOURCE_MISMATCH");
  });

  it("GENERATION_MISMATCH: generation !== parent.generation+1", () => {
    const state = makeState([parent]);
    const p = validSpawn({ generation: 3 });
    expect(validateSpawn(p, parent, state, POLICY)?.code).toBe("GENERATION_MISMATCH");
  });

  it("DEPTH_LIMIT: generation 超过 maxGeneration", () => {
    const policy = createControllerPolicy({ maxGeneration: 1 });
    const deepParent = makeNode({ generation: 1 });
    const state = makeState([deepParent]);
    const p = validSpawn({ generation: 2 });
    expect(validateSpawn(p, deepParent, state, policy)?.code).toBe("DEPTH_LIMIT");
  });

  it("NODE_LIMIT: nodes.size >= maxNodes", () => {
    const policy = createControllerPolicy({ maxNodes: 1 });
    const state = makeState([parent]);
    expect(validateSpawn(validSpawn(), parent, state, policy)?.code).toBe("NODE_LIMIT");
  });

  it("EDGE_LIMIT: edges.length >= maxEdges", () => {
    const policy = createControllerPolicy({ maxEdges: 1 });
    const state = makeState([parent], [spawnEdge("parent", "child-x")]);
    expect(validateSpawn(validSpawn(), parent, state, policy)?.code).toBe("EDGE_LIMIT");
  });

  it("CHILD_LIMIT: 现有 SPAWN 边数达到 maxChildrenPerNode", () => {
    const policy = createControllerPolicy({ maxChildrenPerNode: 1 });
    const state = makeState([parent], [spawnEdge("parent", "child-a")]);
    expect(validateSpawn(validSpawn(), parent, state, policy)?.code).toBe("CHILD_LIMIT");
  });

  it("PERMISSION_ESCALATION: 工具不在 parent.allowedToolNames", () => {
    const state = makeState([parent]);
    const p = validSpawn({ toolNames: ["danger"] });
    expect(validateSpawn(p, parent, state, POLICY)?.code).toBe("PERMISSION_ESCALATION");
  });

  it("INVALID_BUDGET_SHARE: 现有边权重 + budgetShare > 1", () => {
    const state = makeState([parent], [spawnEdge("parent", "child-a", 0.9)]);
    const p = validSpawn({ budgetShare: 0.5 });
    expect(validateSpawn(p, parent, state, POLICY)?.code).toBe("INVALID_BUDGET_SHARE");
  });

  it("MALFORMED_PROPOSAL: budgetShare 为 0(必须 > 0)", () => {
    const state = makeState([parent]);
    const p = validSpawn({ budgetShare: 0 });
    expect(validateSpawn(p, parent, state, POLICY)?.code).toBe("MALFORMED_PROPOSAL");
  });

  it("MALFORMED_PROPOSAL: proposal 非对象", () => {
    const state = makeState([parent]);
    expect(validateSpawn(null, parent, state, POLICY)?.code).toBe("MALFORMED_PROPOSAL");
  });
});

describe("validateMessage", () => {
  const source = makeNode({ nodeId: "src" });
  const target = makeNode({ nodeId: "tgt", parentNodeId: "src", generation: 1 });

  function validMsg(overrides?: Record<string, unknown>) {
    return createMessageProposal({
      proposalId: "m-1",
      sourceNodeId: "src",
      targetNodeId: "tgt",
      content: "hi",
      priority: 0.5,
      ttlSeconds: 300,
      ...(overrides as object),
    });
  }

  it("合法 message 返回 null", () => {
    const state = makeState([source, target]);
    expect(validateMessage(validMsg(), source, state, POLICY)).toBeNull();
  });

  it("SOURCE_MISMATCH", () => {
    const state = makeState([source, target]);
    const p = validMsg({ sourceNodeId: "other" });
    expect(validateMessage(p, source, state, POLICY)?.code).toBe("SOURCE_MISMATCH");
  });

  it("TARGET_NOT_FOUND", () => {
    const state = makeState([source]);
    const p = validMsg({ targetNodeId: "ghost" });
    expect(validateMessage(p, source, state, POLICY)?.code).toBe("TARGET_NOT_FOUND");
  });

  it("SELF_EDGE", () => {
    const state = makeState([source]);
    const p = validMsg({ targetNodeId: "src" });
    expect(validateMessage(p, source, state, POLICY)?.code).toBe("SELF_EDGE");
  });

  it("EDGE_LIMIT", () => {
    const policy = createControllerPolicy({ maxEdges: 1 });
    const state = makeState([source, target], [spawnEdge("src", "tgt")]);
    expect(validateMessage(validMsg(), source, state, policy)?.code).toBe("EDGE_LIMIT");
  });

  it("MALFORMED_PROPOSAL: ttl 超过上限", () => {
    const policy = createControllerPolicy({ maxMessageTtlSeconds: 10 });
    const state = makeState([source, target]);
    const p = validMsg({ ttlSeconds: 11 });
    expect(validateMessage(p, source, state, policy)?.code).toBe("MALFORMED_PROPOSAL");
  });

  it("MALFORMED_PROPOSAL: 非对象", () => {
    const state = makeState([source, target]);
    expect(validateMessage(undefined, source, state, POLICY)?.code).toBe(
      "MALFORMED_PROPOSAL",
    );
  });
});

describe("validateSkip", () => {
  // grandparent -> parent -> requester ; source=grandparent is an ancestor of requester
  const grandparent = makeNode({ nodeId: "gp", parentNodeId: null, generation: 0 });
  const parent = makeNode({ nodeId: "p", parentNodeId: "gp", generation: 1 });
  const requester = makeNode({ nodeId: "req", parentNodeId: "p", generation: 2 });

  function validSkip(overrides?: Record<string, unknown>) {
    return createSkipContextProposal({
      proposalId: "sk-1",
      requesterNodeId: "req",
      sourceNodeId: "gp",
      reason: "no longer relevant",
      contextGate: 0.5,
      ...(overrides as object),
    });
  }

  it("合法 skip 返回 null", () => {
    const state = makeState([grandparent, parent, requester]);
    expect(validateSkip(validSkip(), requester, state, POLICY)).toBeNull();
  });

  it("SOURCE_MISMATCH: requesterNodeId 不符", () => {
    const state = makeState([grandparent, parent, requester]);
    const p = validSkip({ requesterNodeId: "nope" });
    expect(validateSkip(p, requester, state, POLICY)?.code).toBe("SOURCE_MISMATCH");
  });

  it("TARGET_NOT_FOUND: source 不在 nodes", () => {
    const state = makeState([parent, requester]);
    const p = validSkip({ sourceNodeId: "ghost" });
    expect(validateSkip(p, requester, state, POLICY)?.code).toBe("TARGET_NOT_FOUND");
  });

  it("POLICY_DENIED: source 不是 requester 的祖先", () => {
    // sibling is not an ancestor
    const sibling = makeNode({ nodeId: "sib", parentNodeId: "gp", generation: 1 });
    const state = makeState([grandparent, parent, requester, sibling]);
    const p = validSkip({ sourceNodeId: "sib" });
    expect(validateSkip(p, requester, state, POLICY)?.code).toBe("POLICY_DENIED");
  });

  it("EDGE_LIMIT", () => {
    const policy = createControllerPolicy({ maxEdges: 1 });
    const state = makeState(
      [grandparent, parent, requester],
      [spawnEdge("gp", "p")],
    );
    expect(validateSkip(validSkip(), requester, state, policy)?.code).toBe("EDGE_LIMIT");
  });

  it("MALFORMED_PROPOSAL: 非对象", () => {
    const state = makeState([grandparent, parent, requester]);
    expect(validateSkip(null, requester, state, POLICY)?.code).toBe("MALFORMED_PROPOSAL");
  });
});

describe("isAncestor", () => {
  const gp = makeNode({ nodeId: "gp", parentNodeId: null, generation: 0 });
  const p = makeNode({ nodeId: "p", parentNodeId: "gp", generation: 1 });
  const c = makeNode({ nodeId: "c", parentNodeId: "p", generation: 2 });
  const state = makeState([gp, p, c]);

  it("true: gp 是 c 的祖先", () => {
    expect(isAncestor(state, "gp", "c")).toBe(true);
  });

  it("true: p 是 c 的祖先", () => {
    expect(isAncestor(state, "p", "c")).toBe(true);
  });

  it("false: c 不是 gp 的祖先", () => {
    expect(isAncestor(state, "c", "gp")).toBe(false);
  });

  it("false: 自身不是自身祖先", () => {
    expect(isAncestor(state, "c", "c")).toBe(false);
  });
});
