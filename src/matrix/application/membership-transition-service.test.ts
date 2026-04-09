import { describe, expect, it } from "vitest";
import type { PDU } from "../../shared/types";
import {
  MembershipTransitionService,
  toMembershipCommand,
  resolveMembershipAuthState,
} from "./membership-transition-service";

function createMemberEvent(params: {
  eventId: string;
  roomId?: string;
  sender: string;
  stateKey: string;
  membership: "invite" | "join" | "leave" | "ban" | "knock";
}): PDU {
  return {
    event_id: params.eventId,
    room_id: params.roomId ?? "!room:test",
    sender: params.sender,
    type: "m.room.member",
    state_key: params.stateKey,
    content: { membership: params.membership },
    origin_server_ts: 1,
    depth: 1,
    auth_events: [],
    prev_events: [],
  };
}

describe("MembershipTransitionService", () => {
  const service = new MembershipTransitionService();

  it("marks invite rejection as leave and clears invite state", () => {
    const inviteEvent = createMemberEvent({
      eventId: "$invite",
      sender: "@alice:test",
      stateKey: "@bob:test",
      membership: "invite",
    });
    const rejectEvent = createMemberEvent({
      eventId: "$leave",
      sender: "@bob:test",
      stateKey: "@bob:test",
      membership: "leave",
    });

    const result = service.evaluate({
      event: rejectEvent,
      roomId: "!room:test",
      source: "client",
      currentMembership: { membership: "invite", eventId: "$invite" },
      currentMemberEvent: inviteEvent,
      roomState: [inviteEvent],
      inviteStrippedState: [],
    });

    expect(result).toEqual({
      membershipToPersist: "leave",
      shouldUpsertRoomState: true,
      shouldClearInviteStrippedState: true,
      shouldUpsertKnockState: false,
      shouldClearKnockState: false,
      syncCategory: "leave",
    });
  });

  it("marks original inviter rescind as leave and clears invite state", () => {
    const inviteEvent = createMemberEvent({
      eventId: "$invite",
      sender: "@alice:test",
      stateKey: "@bob:test",
      membership: "invite",
    });
    const rescindEvent = createMemberEvent({
      eventId: "$leave",
      sender: "@alice:test",
      stateKey: "@bob:test",
      membership: "leave",
    });

    const result = service.evaluate({
      event: rescindEvent,
      roomId: "!room:test",
      source: "federation",
      currentMembership: { membership: "invite", eventId: "$invite" },
      currentMemberEvent: inviteEvent,
      roomState: [inviteEvent],
      inviteStrippedState: [],
    });

    expect(result.membershipToPersist).toBe("leave");
    expect(result.shouldClearInviteStrippedState).toBe(true);
    expect(result.syncCategory).toBe("leave");
  });

  it("keeps invite when a non-original inviter tries to rescind over federation", () => {
    const inviteEvent = createMemberEvent({
      eventId: "$invite",
      sender: "@alice2:test",
      stateKey: "@bob:test",
      membership: "invite",
    });
    const rescindEvent = createMemberEvent({
      eventId: "$leave",
      sender: "@alice:test",
      stateKey: "@bob:test",
      membership: "leave",
    });

    const result = service.evaluate({
      event: rescindEvent,
      roomId: "!room:test",
      source: "federation",
      currentMembership: { membership: "invite", eventId: "$invite" },
      currentMemberEvent: inviteEvent,
      roomState: [inviteEvent],
      inviteStrippedState: [],
    });

    expect(result).toEqual({
      membershipToPersist: null,
      shouldUpsertRoomState: false,
      shouldClearInviteStrippedState: false,
      shouldUpsertKnockState: false,
      shouldClearKnockState: false,
      syncCategory: "invite",
    });
  });

  it("marks invite accept as join", () => {
    const inviteEvent = createMemberEvent({
      eventId: "$invite",
      sender: "@alice:test",
      stateKey: "@bob:test",
      membership: "invite",
    });
    const joinEvent = createMemberEvent({
      eventId: "$join",
      sender: "@bob:test",
      stateKey: "@bob:test",
      membership: "join",
    });

    const result = service.evaluate({
      event: joinEvent,
      roomId: "!room:test",
      source: "workflow",
      currentMembership: { membership: "invite", eventId: "$invite" },
      currentMemberEvent: inviteEvent,
      roomState: [inviteEvent],
      inviteStrippedState: [],
    });

    expect(result.membershipToPersist).toBe("join");
    expect(result.shouldClearInviteStrippedState).toBe(true);
    expect(result.syncCategory).toBe("join");
  });

  it("marks joined member leave without invite cleanup", () => {
    const joinEvent = createMemberEvent({
      eventId: "$join",
      sender: "@bob:test",
      stateKey: "@bob:test",
      membership: "join",
    });
    const leaveEvent = createMemberEvent({
      eventId: "$leave",
      sender: "@bob:test",
      stateKey: "@bob:test",
      membership: "leave",
    });

    const result = service.evaluate({
      event: leaveEvent,
      roomId: "!room:test",
      source: "client",
      currentMembership: { membership: "join", eventId: "$join" },
      currentMemberEvent: joinEvent,
      roomState: [joinEvent],
      inviteStrippedState: [],
    });

    expect(result.membershipToPersist).toBe("leave");
    expect(result.shouldClearInviteStrippedState).toBe(false);
    expect(result.syncCategory).toBe("leave");
  });

  it("persists bans and exposes them as leave sync category", () => {
    const joinEvent = createMemberEvent({
      eventId: "$join",
      sender: "@bob:test",
      stateKey: "@bob:test",
      membership: "join",
    });
    const banEvent = createMemberEvent({
      eventId: "$ban",
      sender: "@alice:test",
      stateKey: "@bob:test",
      membership: "ban",
    });

    const result = service.evaluate({
      event: banEvent,
      roomId: "!room:test",
      source: "client",
      currentMembership: { membership: "join", eventId: "$join" },
      currentMemberEvent: joinEvent,
      roomState: [joinEvent],
      inviteStrippedState: [],
    });

    expect(result.membershipToPersist).toBe("ban");
    expect(result.syncCategory).toBe("leave");
    expect(result.shouldUpsertRoomState).toBe(true);
  });

  it("marks a knock transition and requests knock persistence", () => {
    const knockEvent = createMemberEvent({
      eventId: "$knock",
      sender: "@bob:test",
      stateKey: "@bob:test",
      membership: "knock",
    });

    const result = service.evaluate({
      event: knockEvent,
      roomId: "!room:test",
      source: "client",
      currentMembership: null,
      currentMemberEvent: null,
      roomState: [],
      inviteStrippedState: [],
    });

    expect(result).toEqual({
      membershipToPersist: "knock",
      shouldUpsertRoomState: true,
      shouldClearInviteStrippedState: false,
      shouldUpsertKnockState: true,
      shouldClearKnockState: false,
      syncCategory: "knock",
    });
  });

  it("builds a membership command for supported membership events", () => {
    const inviteEvent = createMemberEvent({
      eventId: "$invite",
      sender: "@alice:test",
      stateKey: "@bob:test",
      membership: "invite",
    });

    expect(
      toMembershipCommand({
        event: inviteEvent,
        roomId: "!room:test",
        source: "federation",
        currentMembership: null,
        currentMemberEvent: null,
        roomState: [],
        inviteStrippedState: [],
      }),
    ).toEqual({
      kind: "invite",
      roomId: "!room:test",
      sender: "@alice:test",
      targetUserId: "@bob:test",
      source: "federation",
      event: inviteEvent,
    });
  });

  it("clears knock state once a knocking user joins", () => {
    const knockEvent = createMemberEvent({
      eventId: "$knock",
      sender: "@bob:test",
      stateKey: "@bob:test",
      membership: "knock",
    });
    const joinEvent = createMemberEvent({
      eventId: "$join",
      sender: "@bob:test",
      stateKey: "@bob:test",
      membership: "join",
    });

    const result = service.evaluate({
      event: joinEvent,
      roomId: "!room:test",
      source: "workflow",
      currentMembership: { membership: "knock", eventId: "$knock" },
      currentMemberEvent: knockEvent,
      roomState: [knockEvent],
      inviteStrippedState: [],
    });

    expect(result.membershipToPersist).toBe("join");
    expect(result.shouldUpsertKnockState).toBe(false);
    expect(result.shouldClearKnockState).toBe(true);
    expect(result.syncCategory).toBe("join");
  });

  it("merges stripped invite state when room_state lacks create", () => {
    const inviteState = [
      {
        type: "m.room.create",
        state_key: "",
        content: { creator: "@alice:test", room_version: "10" },
        sender: "@alice:test",
      },
      {
        type: "m.room.member",
        state_key: "@bob:test",
        content: { membership: "invite" },
        sender: "@alice:test",
      },
    ];
    const partialRoomState = [
      createMemberEvent({
        eventId: "$invite",
        sender: "@alice:test",
        stateKey: "@bob:test",
        membership: "invite",
      }),
    ];

    const resolved = resolveMembershipAuthState("!room:test", partialRoomState, inviteState);

    expect(
      resolved.find((event) => event.type === "m.room.create" && event.state_key === ""),
    ).toBeDefined();
  });
});
