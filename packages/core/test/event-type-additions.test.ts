import { describe, expect, it } from "vitest";
import { EventType } from "../src/events.js";

describe("EventType model/tool additions", () => {
  it("exposes the 6 new model/tool event types with exact string values", () => {
    expect(EventType.MODEL_STARTED).toBe("model_started");
    expect(EventType.MODEL_COMPLETED).toBe("model_completed");
    expect(EventType.TOOL_STARTED).toBe("tool_started");
    expect(EventType.TOOL_COMPLETED).toBe("tool_completed");
    expect(EventType.TOOL_REJECTED).toBe("tool_rejected");
    expect(EventType.PROPOSAL_CREATED).toBe("proposal_created");
  });

  it("keeps the original 4 node/budget event types intact", () => {
    expect(EventType.NODE_STARTED).toBe("node_started");
    expect(EventType.NODE_COMPLETED).toBe("node_completed");
    expect(EventType.NODE_FAILED).toBe("node_failed");
    expect(EventType.BUDGET_EXCEEDED).toBe("budget_exceeded");
  });
});
