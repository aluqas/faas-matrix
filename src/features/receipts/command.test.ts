import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { sendReceiptEffect, setReadMarkersEffect, type ReceiptsCommandPorts } from "./command";

function createPorts(): {
  ports: ReceiptsCommandPorts;
  calls: {
    fullyRead: Array<{ userId: string; roomId: string; eventId: string }>;
    receipts: Array<{ roomId: string; userId: string; eventId: string; type: string; threadId?: string }>;
    queued: Array<{ destination: string; content: Record<string, unknown> }>;
  };
} {
  const calls = {
    fullyRead: [] as Array<{ userId: string; roomId: string; eventId: string }>,
    receipts: [] as Array<{ roomId: string; userId: string; eventId: string; type: string; threadId?: string }>,
    queued: [] as Array<{ destination: string; content: Record<string, unknown> }>,
  };

  return {
    calls,
    ports: {
      membership: {
        isUserJoinedToRoom: () => Effect.succeed(true),
      },
      fullyReadStore: {
        putFullyRead: (userId, roomId, eventId) =>
          Effect.sync(() => {
            calls.fullyRead.push({ userId, roomId, eventId });
          }),
      },
      roomReceiptStore: {
        putReceipt: (roomId, userId, eventId, receiptType, threadId) =>
          Effect.sync(() => {
            calls.receipts.push({ roomId, userId, eventId, type: receiptType, ...(threadId ? { threadId } : {}) });
          }),
      },
      federation: {
        listJoinedServers: () => Effect.succeed(["remote.test"]),
        queueReceipt: (destination, content) =>
          Effect.sync(() => {
            calls.queued.push({ destination, content });
          }),
      },
    },
  };
}

describe("receipts command", () => {
  it("stores fully-read markers without using room receipts", async () => {
    const { ports, calls } = createPorts();

    await Effect.runPromise(
      sendReceiptEffect(ports, {
        userId: "@alice:test",
        roomId: "!room:test",
        receiptType: "m.fully_read",
        eventId: "$event",
        now: 123,
      }),
    );

    expect(calls.fullyRead).toEqual([
      { userId: "@alice:test", roomId: "!room:test", eventId: "$event" },
    ]);
    expect(calls.receipts).toEqual([]);
    expect(calls.queued).toEqual([]);
  });

  it("stores public receipts, queues federation, and advances unthreaded fully-read", async () => {
    const { ports, calls } = createPorts();

    await Effect.runPromise(
      sendReceiptEffect(ports, {
        userId: "@alice:test",
        roomId: "!room:test",
        receiptType: "m.read",
        eventId: "$event",
        now: 456,
      }),
    );

    expect(calls.receipts).toEqual([
      { roomId: "!room:test", userId: "@alice:test", eventId: "$event", type: "m.read" },
    ]);
    expect(calls.fullyRead).toEqual([
      { userId: "@alice:test", roomId: "!room:test", eventId: "$event" },
    ]);
    expect(calls.queued).toHaveLength(1);
  });

  it("does not advance fully-read for threaded public receipts", async () => {
    const { ports, calls } = createPorts();

    await Effect.runPromise(
      sendReceiptEffect(ports, {
        userId: "@alice:test",
        roomId: "!room:test",
        receiptType: "m.read",
        eventId: "$event",
        threadId: "$thread",
        now: 789,
      }),
    );

    expect(calls.receipts).toEqual([
      {
        roomId: "!room:test",
        userId: "@alice:test",
        eventId: "$event",
        type: "m.read",
        threadId: "$thread",
      },
    ]);
    expect(calls.fullyRead).toEqual([]);
  });

  it("updates fully-read fallback when read markers omit it", async () => {
    const { ports, calls } = createPorts();

    await Effect.runPromise(
      setReadMarkersEffect(ports, {
        userId: "@alice:test",
        roomId: "!room:test",
        read: "$event",
      }),
    );

    expect(calls.receipts).toEqual([
      { roomId: "!room:test", userId: "@alice:test", eventId: "$event", type: "m.read" },
    ]);
    expect(calls.fullyRead).toEqual([
      { userId: "@alice:test", roomId: "!room:test", eventId: "$event" },
    ]);
  });
});
