import { canonicalJson } from "@graph-agent/core";
import { describe, expect, it } from "vitest";
import {
  ackAfterHistory,
  deliveryStatus,
  pendingDeliveries,
  putIfAbsent,
} from "../src/inbox.js";
import { InMemoryStorage } from "../src/storage.js";

const SESSION = "s1";
const envPath = (id: string) => `sessions/${SESSION}/inbox/${id}.env.json`;
const receiptPath = (id: string) => `sessions/${SESSION}/inbox/${id}.receipt.json`;

describe("inbox putIfAbsent", () => {
  it("first call accepted, second duplicate, envelope not overwritten", async () => {
    const storage = new InMemoryStorage();
    const first = { body: "first" };
    const second = { body: "second-should-be-ignored" };

    expect(await putIfAbsent(storage, SESSION, "m1", first)).toBe("accepted");
    expect(await putIfAbsent(storage, SESSION, "m1", second)).toBe("duplicate");

    // Envelope NOT overwritten: stored content equals the first envelope.
    expect(await storage.read(envPath("m1"))).toBe(canonicalJson(first));
  });
});

describe("inbox ackAfterHistory ordering", () => {
  it("runs history callback BEFORE writing receipt (history-before-ACK)", async () => {
    const storage = new InMemoryStorage();
    await putIfAbsent(storage, SESSION, "m1", { body: "x" });

    const order: string[] = [];
    await ackAfterHistory(storage, SESSION, "m1", async () => {
      order.push("history");
      // At callback time the receipt must NOT exist yet.
      expect(await storage.exists(receiptPath("m1"))).toBe(false);
    });

    // History ran and, only after it returned, the receipt was written.
    expect(order).toEqual(["history"]);
    expect(await storage.exists(receiptPath("m1"))).toBe(true);
  });

  it("is idempotent: a retried ack after a successful append does not error", async () => {
    const storage = new InMemoryStorage();
    await putIfAbsent(storage, SESSION, "m1", { body: "x" });
    let calls = 0;
    const append = async () => {
      calls += 1;
    };
    await ackAfterHistory(storage, SESSION, "m1", append);
    await ackAfterHistory(storage, SESSION, "m1", append);
    expect(calls).toBe(2);
    expect(await deliveryStatus(storage, SESSION, "m1")).toBe("delivered");
  });

  it("callback throws → rejects, no receipt, status stays pending", async () => {
    const storage = new InMemoryStorage();
    await putIfAbsent(storage, SESSION, "m1", { body: "x" });

    await expect(
      ackAfterHistory(storage, SESSION, "m1", async () => {
        throw new Error("history failed");
      }),
    ).rejects.toThrow("history failed");

    expect(await storage.exists(receiptPath("m1"))).toBe(false);
    expect(await deliveryStatus(storage, SESSION, "m1")).toBe("pending");
  });
});

describe("inbox deliveryStatus transitions", () => {
  it("none → pending → delivered", async () => {
    const storage = new InMemoryStorage();
    expect(await deliveryStatus(storage, SESSION, "m1")).toBe("none");

    await putIfAbsent(storage, SESSION, "m1", { body: "x" });
    expect(await deliveryStatus(storage, SESSION, "m1")).toBe("pending");

    await ackAfterHistory(storage, SESSION, "m1", async () => {});
    expect(await deliveryStatus(storage, SESSION, "m1")).toBe("delivered");
  });
});

describe("inbox pendingDeliveries", () => {
  it("absent dir → []", async () => {
    const storage = new InMemoryStorage();
    expect(await pendingDeliveries(storage, SESSION)).toEqual([]);
  });

  it("lists env-without-receipt, excludes delivered, deterministic sort", async () => {
    const storage = new InMemoryStorage();
    await putIfAbsent(storage, SESSION, "m2", { body: "b" });
    await putIfAbsent(storage, SESSION, "m1", { body: "a" });
    await putIfAbsent(storage, SESSION, "m3", { body: "c" });

    // Deliver m2 → excluded from pending.
    await ackAfterHistory(storage, SESSION, "m2", async () => {});

    expect(await pendingDeliveries(storage, SESSION)).toEqual(["m1", "m3"]);
  });
});
