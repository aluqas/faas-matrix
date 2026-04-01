import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  validateInviteRequest,
  validateSendJoinRequest,
  validateSendKnockRequest,
  validateSendLeaveRequest,
  validateThirdPartyInviteExchangeRequest,
} from "./federation-validation";

describe("federation validation", () => {
  it("rejects non-join send_join events", async () => {
    const effect = validateSendJoinRequest({
      roomId: "!room:test",
      eventId: "$join",
      body: {
        event_id: "$join",
        room_id: "!room:test",
        sender: "@alice:test",
        type: "m.room.member",
        state_key: "@alice:test",
        content: { membership: "leave" },
        origin_server_ts: 1,
      },
    });

    await expect(Effect.runPromise(effect)).rejects.toThrow(
      "Only join membership events are accepted via send_join",
    );
  });

  it("rejects leave events that target another user", async () => {
    const effect = validateSendLeaveRequest({
      roomId: "!room:test",
      eventId: "$leave",
      body: {
        event_id: "$leave",
        room_id: "!room:test",
        sender: "@alice:test",
        state_key: "@bob:test",
        type: "m.room.member",
        content: { membership: "leave" },
        origin_server_ts: 1,
      },
    });

    await expect(Effect.runPromise(effect)).rejects.toThrow(
      "Leave events must target the sending user",
    );
  });

  it("preserves top-level federation membership fields on send_join", async () => {
    const effect = validateSendJoinRequest({
      roomId: "!room:test",
      eventId: "$join",
      body: {
        event_id: "$join",
        room_id: "!room:test",
        sender: "@alice:remote.test",
        origin: "remote.test",
        membership: "join",
        prev_state: ["$prev:test"],
        state_key: "@alice:remote.test",
        type: "m.room.member",
        content: { membership: "join" },
        origin_server_ts: 1,
      },
    });

    await expect(Effect.runPromise(effect)).resolves.toMatchObject({
      event: {
        origin: "remote.test",
        membership: "join",
        prev_state: ["$prev:test"],
      },
    });
  });

  it("validates v2 invites require a supported room version and local target", async () => {
    const effect = validateInviteRequest({
      eventId: "$invite",
      serverName: "test",
      requireRoomVersion: true,
      body: {
        room_version: "10",
        event: {
          event_id: "$invite",
          room_id: "!room:test",
          sender: "@alice:remote",
          type: "m.room.member",
          state_key: "@bob:test",
          content: { membership: "invite" },
          origin_server_ts: 1,
        },
        invite_room_state: [
          { type: "m.room.name", sender: "@alice:remote", content: { name: "T" } },
        ],
      },
    });

    await expect(Effect.runPromise(effect)).resolves.toMatchObject({
      roomVersion: "10",
      invitedUserId: "@bob:test",
      roomId: "!room:test",
    });
  });

  it("rejects send_knock when membership is not knock", async () => {
    const effect = validateSendKnockRequest({
      roomId: "!room:test",
      eventId: "$knock",
      body: {
        event_id: "$knock",
        room_id: "!room:test",
        sender: "@alice:test",
        type: "m.room.member",
        state_key: "@alice:test",
        content: { membership: "join" },
        origin_server_ts: 1,
      },
    });

    await expect(Effect.runPromise(effect)).rejects.toThrow("Event is not a knock event");
  });

  it("validates third party invite exchange payloads", async () => {
    const effect = validateThirdPartyInviteExchangeRequest({
      roomId: "!room:test",
      body: {
        type: "m.room.member",
        room_id: "!room:test",
        sender: "@alice:remote.test",
        state_key: "@bob:test",
        content: {
          membership: "invite",
          third_party_invite: {
            display_name: "Bob",
            signed: {
              mxid: "@bob:test",
              token: "token-1",
              signatures: {
                "is.example": {
                  "ed25519:key": "sig",
                },
              },
            },
          },
        },
      },
    });

    await expect(Effect.runPromise(effect)).resolves.toMatchObject({
      roomId: "!room:test",
      stateKey: "@bob:test",
      signed: {
        mxid: "@bob:test",
        token: "token-1",
      },
    });
  });

  it("rejects third party invite exchanges when mxid mismatches state_key", async () => {
    const effect = validateThirdPartyInviteExchangeRequest({
      roomId: "!room:test",
      body: {
        type: "m.room.member",
        room_id: "!room:test",
        sender: "@alice:remote.test",
        state_key: "@bob:test",
        content: {
          membership: "invite",
          third_party_invite: {
            signed: {
              mxid: "@carol:test",
              token: "token-1",
              signatures: {
                "is.example": {
                  "ed25519:key": "sig",
                },
              },
            },
          },
        },
      },
    });

    await expect(Effect.runPromise(effect)).rejects.toThrow("mxid does not match state_key");
  });
});
