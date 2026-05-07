import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { authorizeLocalJoin } from "./room-membership-policy";

describe("authorizeLocalJoin – restricted rooms", () => {
  const allowList = [{ type: "m.room_membership", room_id: "!allowed:hs1" }];
  const joinRulesContent = { join_rule: "restricted", allow: allowList };

  it("returns authorizingUser when membership check and authorizer resolver both succeed", async () => {
    const result = await Effect.runPromise(
      authorizeLocalJoin({
        roomVersion: "10",
        joinRulesContent,
        currentMembership: undefined,
        checkAllowedRoomMembership: (_roomId) => Effect.succeed(true),
        resolveAuthorizingUser: () => Effect.succeed("@admin:hs1"),
      }),
    );

    expect(result.alreadyJoined).toBe(false);
    expect(result.joinRule).toBe("restricted");
    expect(result.authorizingUser).toBe("@admin:hs1");
  });

  it("fails with 403 when user is not a member of any allowed room", async () => {
    const effect = authorizeLocalJoin({
      roomVersion: "10",
      joinRulesContent,
      currentMembership: undefined,
      checkAllowedRoomMembership: (_roomId) => Effect.succeed(false),
      resolveAuthorizingUser: () => Effect.succeed("@admin:hs1"),
    });

    await expect(Effect.runPromise(effect)).rejects.toThrow();
  });

  it("fails with 403 when no authorizing user resolver is provided", async () => {
    const effect = authorizeLocalJoin({
      roomVersion: "10",
      joinRulesContent,
      currentMembership: undefined,
      checkAllowedRoomMembership: (_roomId) => Effect.succeed(true),
      resolveAuthorizingUser: undefined,
    });

    await expect(Effect.runPromise(effect)).rejects.toThrow();
  });

  it("fails with 403 when authorizing user resolver returns null", async () => {
    const effect = authorizeLocalJoin({
      roomVersion: "10",
      joinRulesContent,
      currentMembership: undefined,
      checkAllowedRoomMembership: (_roomId) => Effect.succeed(true),
      resolveAuthorizingUser: () => Effect.succeed(null),
    });

    await expect(Effect.runPromise(effect)).rejects.toThrow();
  });

  it("succeeds for public rooms without resolveAuthorizingUser", async () => {
    const result = await Effect.runPromise(
      authorizeLocalJoin({
        roomVersion: "10",
        joinRulesContent: { join_rule: "public" },
        currentMembership: undefined,
      }),
    );

    expect(result.alreadyJoined).toBe(false);
    expect(result.joinRule).toBe("public");
    expect(result.authorizingUser).toBeUndefined();
  });
});
