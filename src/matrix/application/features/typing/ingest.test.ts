import { describe, expect, it } from "vitest";
import { ingestTypingEdu } from "./ingest";

describe("typing ingest", () => {
  it("applies remote typing only for joined users on the origin server", async () => {
    const calls: Array<{ roomId: string; userId: string; typing: boolean; timeoutMs?: number }> =
      [];

    await ingestTypingEdu(
      "remote",
      {
        room_id: "!room:hs1",
        user_id: "@alice:remote",
        typing: true,
        timeout: 5_000,
      },
      {
        async getMembership() {
          return "join";
        },
        async setRoomTyping(roomId, userId, typing, timeoutMs) {
          calls.push({ roomId, userId, typing, timeoutMs });
        },
      },
    );

    await ingestTypingEdu(
      "remote",
      {
        room_id: "!room:hs1",
        user_id: "@mallory:evil",
        typing: true,
      },
      {
        async getMembership() {
          return "join";
        },
        async setRoomTyping() {
          throw new Error("should not be called");
        },
      },
    );

    expect(calls).toEqual([
      {
        roomId: "!room:hs1",
        userId: "@alice:remote",
        typing: true,
        timeoutMs: 5_000,
      },
    ]);
  });
});
