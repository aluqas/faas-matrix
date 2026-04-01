import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  validateCreateRoomRequest,
  validateInviteRoomRequest,
  validateJoinRoomRequest,
  validateModerationRequest,
} from "./room-validation";

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

    await expect(Effect.runPromise(Effect.flip(effect))).resolves.toMatchObject({
      errcode: "M_UNSUPPORTED_ROOM_VERSION",
      message: "Unsupported room version: 999",
    });
  });

  it("accepts room_alias_name for createRoom", async () => {
    const effect = validateCreateRoomRequest({
      room_alias_name: "room_alias",
    });

    await expect(Effect.runPromise(effect)).resolves.toMatchObject({
      room_alias_name: "room_alias",
    });
  });

  it("accepts unstable owned-state room versions in createRoom", async () => {
    const effect = validateCreateRoomRequest({
      room_version: "org.matrix.msc3757.10",
    });

    await expect(Effect.runPromise(effect)).resolves.toMatchObject({
      room_version: "org.matrix.msc3757.10",
    });
  });

  it("normalizes remote server hints for joinRoom", async () => {
    const effect = validateJoinRoomRequest({
      roomId: "!room:test",
      remoteServers: [" remote.test ", "remote.test", "backup.test"],
      content: { foo: "bar" },
    });

    await expect(Effect.runPromise(effect)).resolves.toEqual({
      roomId: "!room:test",
      remoteServers: ["remote.test", "backup.test"],
      content: { foo: "bar" },
    });
  });

  it("rejects invalid invite user ids", async () => {
    const effect = validateInviteRoomRequest({
      roomId: "!room:test",
      targetUserId: "alice",
    });

    await expect(Effect.runPromise(effect)).rejects.toThrow("user_id must be a Matrix user ID");
  });

  it("accepts moderation requests with valid matrix identifiers", async () => {
    const effect = validateModerationRequest({
      roomId: "!room:test",
      targetUserId: "@alice:test",
      reason: "policy",
    });

    await expect(Effect.runPromise(effect)).resolves.toEqual({
      roomId: "!room:test",
      targetUserId: "@alice:test",
      reason: "policy",
    });
  });
});
