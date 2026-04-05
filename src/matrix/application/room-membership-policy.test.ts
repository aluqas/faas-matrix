import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  authorizeBan,
  authorizeLocalInvite,
  authorizeLocalJoin,
  authorizeLocalKnock,
  authorizeKick,
  authorizeUnban,
  validateLeavePreconditions,
  validateKnockPreconditions,
} from "./room-membership-policy";

describe("room-membership-policy", () => {
  it("allows public joins without an invite", async () => {
    const effect = authorizeLocalJoin({
      roomVersion: "10",
      joinRulesContent: { join_rule: "public" },
      currentMembership: null,
    });

    await expect(Effect.runPromise(effect)).resolves.toMatchObject({
      alreadyJoined: false,
      joinRule: "public",
    });
  });

  it("rejects restricted joins when no allowed rooms are configured", async () => {
    const effect = authorizeLocalJoin({
      roomVersion: "10",
      joinRulesContent: { join_rule: "restricted", allow: [] },
      currentMembership: null,
      checkAllowedRoomMembership: () => Effect.succeed(true),
    });

    await expect(Effect.runPromise(effect)).rejects.toThrow(
      "Restricted room has no allowed rooms configured",
    );
  });

  it("rejects restricted joins when membership check port is absent", async () => {
    const effect = authorizeLocalJoin({
      roomVersion: "10",
      joinRulesContent: {
        join_rule: "restricted",
        allow: [{ type: "m.room_membership", room_id: "!allowed:test" }],
      },
      currentMembership: null,
    });

    await expect(Effect.runPromise(effect)).rejects.toThrow(
      "Cannot join restricted room: membership check unavailable",
    );
  });

  it("allows restricted joins when user is a member of an allowed room", async () => {
    const effect = authorizeLocalJoin({
      roomVersion: "10",
      joinRulesContent: {
        join_rule: "restricted",
        allow: [{ type: "m.room_membership", room_id: "!allowed:test" }],
      },
      currentMembership: null,
      checkAllowedRoomMembership: (roomId) => Effect.succeed(roomId === "!allowed:test"),
    });

    await expect(Effect.runPromise(effect)).resolves.toMatchObject({
      alreadyJoined: false,
      joinRule: "restricted",
    });
  });

  it("rejects restricted joins when user is not in any allowed room", async () => {
    const effect = authorizeLocalJoin({
      roomVersion: "10",
      joinRulesContent: {
        join_rule: "restricted",
        allow: [{ type: "m.room_membership", room_id: "!allowed:test" }],
      },
      currentMembership: null,
      checkAllowedRoomMembership: () => Effect.succeed(false),
    });

    await expect(Effect.runPromise(effect)).rejects.toThrow(
      "Not a member of any allowed room for this restricted room",
    );
  });

  it("rejects knock rules that the room version does not support", async () => {
    const effect = authorizeLocalKnock({
      roomVersion: "6",
      joinRule: "knock",
      currentMembership: null,
    });

    await expect(Effect.runPromise(effect)).rejects.toThrow(
      "Join rule 'knock' is not supported in room version '6'",
    );
  });

  it("rejects knocking when the user is already invited", async () => {
    const effect = validateKnockPreconditions("invite");

    await expect(Effect.runPromise(effect)).rejects.toThrow("User is already invited to this room");
  });

  it("allows knock_restricted when the room version supports it", async () => {
    const effect = authorizeLocalKnock({
      roomVersion: "10",
      joinRule: "knock_restricted",
      currentMembership: null,
    });

    await expect(Effect.runPromise(effect)).resolves.toMatchObject({
      joinRule: "knock_restricted",
    });
  });

  it("rejects leave when the user is not in a leavable membership state", async () => {
    const effect = validateLeavePreconditions(null);

    await expect(Effect.runPromise(effect)).rejects.toThrow(
      "Not joined, invited, or knocking in this room",
    );
  });

  it("allows idempotent leave when the user already left", async () => {
    const effect = validateLeavePreconditions("leave");

    await expect(Effect.runPromise(effect)).resolves.toBeUndefined();
  });

  it("rejects invites from users without invite power", async () => {
    const effect = authorizeLocalInvite({
      inviterMembership: "join",
      inviteeMembership: null,
      inviterPower: 0,
      invitePower: 50,
    });

    await expect(Effect.runPromise(effect)).rejects.toThrow("Insufficient power level to invite");
  });

  it("allows invites from joined users with sufficient power", async () => {
    const effect = authorizeLocalInvite({
      inviterMembership: "join",
      inviteeMembership: null,
      inviterPower: 50,
      invitePower: 50,
    });

    await expect(Effect.runPromise(effect)).resolves.toMatchObject({
      inviterPower: 50,
      invitePower: 50,
    });
  });

  it("rejects kicks when the actor cannot kick the target", async () => {
    const effect = authorizeKick({
      actorMembership: "join",
      targetMembership: "join",
      actorPower: 50,
      targetPower: 50,
      kickPower: 50,
      canRescindInvite: false,
    });

    await expect(Effect.runPromise(effect)).rejects.toThrow("Insufficient power level to kick");
  });

  it("allows bans when actor has sufficient power", async () => {
    const effect = authorizeBan({
      actorMembership: "join",
      actorPower: 100,
      targetPower: 0,
      banPower: 50,
    });

    await expect(Effect.runPromise(effect)).resolves.toMatchObject({ actorPower: 100 });
  });

  it("rejects unban when target is not banned", async () => {
    const effect = authorizeUnban({
      actorMembership: "join",
      targetMembership: "leave",
      actorPower: 100,
      banPower: 50,
    });

    await expect(Effect.runPromise(effect)).rejects.toThrow("User is not banned");
  });
});
