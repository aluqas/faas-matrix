import { describe, expect, it } from "vitest";
import { executeTypingCommand } from "./command";

describe("typing command", () => {
  it("updates local typing state and queues remote typing EDUs", async () => {
    const calls: Array<{ roomId: string; userId: string; typing: boolean; timeoutMs?: number }> =
      [];
    const queued: Array<{ destination: string; content: Record<string, unknown> }> = [];

    await executeTypingCommand(
      {
        roomId: "!room:hs1",
        userId: "@alice:test",
        typing: true,
        timeoutMs: 10_000,
      },
      {
        async setRoomTyping(roomId, userId, typing, timeoutMs) {
          calls.push({ roomId, userId, typing, timeoutMs });
        },
        async resolveInterestedServers() {
          return ["remote-a", "remote-b"];
        },
        async queueEdu(destination, content) {
          queued.push({ destination, content });
        },
      },
    );

    expect(calls).toEqual([
      {
        roomId: "!room:hs1",
        userId: "@alice:test",
        typing: true,
        timeoutMs: 10_000,
      },
    ]);
    expect(queued).toEqual([
      {
        destination: "remote-a",
        content: {
          room_id: "!room:hs1",
          user_id: "@alice:test",
          typing: true,
          timeout: 10_000,
        },
      },
      {
        destination: "remote-b",
        content: {
          room_id: "!room:hs1",
          user_id: "@alice:test",
          typing: true,
          timeout: 10_000,
        },
      },
    ]);
  });
});
