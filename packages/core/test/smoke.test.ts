import { describe, expect, it } from "vitest";
import {
  EventRecorder,
  EventType,
  GENESIS_HASH,
  NodeStatus,
  canonicalJson,
  createAgentIdentity,
  createAgentInput,
  createAgentResult,
  createContextPacket,
  createMessageProposal,
  createNodeBudget,
  createNodeError,
  createSkipContextProposal,
  createSpawnProposal,
  createUsage,
  resultBindingHash,
  sha256,
  usageTotalTokens,
  valueHash,
  verifyEventChain,
} from "../src/index.js";

describe("public API", () => {
  it("re-exports the full core surface", () => {
    expect(typeof canonicalJson).toBe("function");
    expect(typeof sha256).toBe("function");
    expect(typeof valueHash).toBe("function");
    expect(typeof createAgentIdentity).toBe("function");
    expect(typeof createNodeBudget).toBe("function");
    expect(typeof createUsage).toBe("function");
    expect(typeof usageTotalTokens).toBe("function");
    expect(typeof createNodeError).toBe("function");
    expect(typeof createContextPacket).toBe("function");
    expect(typeof createAgentInput).toBe("function");
    expect(typeof createAgentResult).toBe("function");
    expect(typeof createSpawnProposal).toBe("function");
    expect(typeof createMessageProposal).toBe("function");
    expect(typeof createSkipContextProposal).toBe("function");
    expect(typeof resultBindingHash).toBe("function");
    expect(typeof verifyEventChain).toBe("function");
    expect(NodeStatus.COMPLETED).toBe("completed");
    expect(EventType.NODE_STARTED).toBe("node_started");
    expect(GENESIS_HASH).toHaveLength(64);
    expect(EventRecorder).toBeTypeOf("function");
  });

  it("assembles a full AgentResult end-to-end", () => {
    const rec = new EventRecorder("n1", () => 1);
    rec.record({ type: EventType.NODE_STARTED });
    rec.record({ type: EventType.NODE_COMPLETED, outputValue: "ok" });
    const result = createAgentResult({
      nodeId: "n1",
      status: NodeStatus.COMPLETED,
      output: "ok",
      usage: createUsage({ inputTokens: 2, outputTokens: 3 }),
      events: rec.events,
      spawnProposals: [
        createSpawnProposal({
          proposalId: "p1",
          parentNodeId: "n1",
          generation: 1,
          role: "r",
          objective: "o",
          instructions: "i",
        }),
      ],
    });
    expect(result.status).toBe("completed");
    expect(usageTotalTokens(result.usage)).toBe(5);
    expect(verifyEventChain(result.events)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    // identity/context also compose without error
    createAgentIdentity({ nodeId: "n1", name: "root", role: "r" });
    createAgentInput({
      task: "t",
      context: [createContextPacket({ sourceNodeId: "s", content: "c" })],
    });
    createNodeError({ code: "E", message: "m" });
    createMessageProposal({ proposalId: "m1", sourceNodeId: "a", targetNodeId: "b", content: "x" });
    createSkipContextProposal({ proposalId: "s1", requesterNodeId: "a", sourceNodeId: "b", reason: "r" });
    createNodeBudget();
  });
});
