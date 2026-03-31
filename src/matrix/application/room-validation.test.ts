import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { validateCreateRoomRequest, validateJoinRoomRequest } from "./room-validation";

describe("room-validation", () => {
  it("rejects duplicate encryption state in createRoom", async () => {
    const effect = validateCreateRoomRequest({
      initial_state: [
        {
          type: "m.room.encryption",
          state_key: "",
          content: { algorithm: "m.megolm.v1.aes-sha2" },
        },
        {
          type: "m.room.encryption",
          state_key: "",
          content: { algorithm: "m.megolm.v1.aes-sha2" },
        },
      ],
    });

    await expect(Effect.runPromise(effect)).rejects.toThrow(
      "Cannot specify multiple m.room.encryption events in initial_state",
    );
  });

  it("rejects unsupported room versions in createRoom", async () => {
    const effect = validateCreateRoomRequest({
      room_version: "999",
    });

    await expect(Effect.runPromise(effect)).rejects.toThrow("Unsupported room version: 999");
  });

  it("normalizes remote server hints for joinRoom", async () => {
    const effect = validateJoinRoomRequest({
      roomId: "!room:test",
      remoteServers: [" remote.test ", "remote.test", "backup.test"],
    });

    await expect(Effect.runPromise(effect)).resolves.toEqual({
      roomId: "!room:test",
      remoteServers: ["remote.test", "backup.test"],
    });
  });
});
