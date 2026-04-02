import { describe, expect, it } from "vitest";

import type { PDU } from "../../../../types";
import { buildModerationAuthorizationContext, buildModerationMembershipEvent } from "./moderation";

describe("rooms moderation helpers", () => {
  it("derives moderation power levels from room power levels", () => {
    const context = buildModerationAuthorizationContext({
      actorUserId: "@alice:test",
      targetUserId: "@bob:test",
      actorMembership: { membership: "join", eventId: "$alice-member" },
      targetMembership: { membership: "invite", eventId: "$invite" },
      targetMembershipEvent: null,
      powerLevelsEvent: {
        event_id: "$power",
        room_id: "!room:test",
        sender: "@creator:test",
        type: "m.room.power_levels",
        state_key: "",
        content: {
          kick: 40,
          ban: 60,
          users: {
            "@alice:test": 100,
            "@bob:test": 10,
          },
        },
        origin_server_ts: 1,
        depth: 1,
        auth_events: [],
        prev_events: [],
      },
    });

    expect(context.actorPower).toBe(100);
    expect(context.targetPower).toBe(10);
    expect(context.kickPower).toBe(40);
    expect(context.banPower).toBe(60);
  });

  it("builds moderation membership events with previous membership metadata", async () => {
    const targetMembershipEvent: PDU = {
      event_id: "$invite",
      room_id: "!room:test",
      sender: "@alice:test",
      type: "m.room.member",
      state_key: "@bob:test",
      content: { membership: "invite" },
      origin_server_ts: 3,
      depth: 3,
      auth_events: [],
      prev_events: [],
    };

    const event = await buildModerationMembershipEvent({
      roomId: "!room:test",
      actorUserId: "@alice:test",
      targetUserId: "@bob:test",
      membership: "leave",
      reason: "cleanup",
      serverName: "test",
      generateEventId: async () => "$generated",
      now: () => 4,
      createEvent: {
        event_id: "$create",
        room_id: "!room:test",
        sender: "@creator:test",
        type: "m.room.create",
        state_key: "",
        content: { creator: "@creator:test", room_version: "10" },
        origin_server_ts: 1,
        depth: 1,
        auth_events: [],
        prev_events: [],
      },
      powerLevelsEvent: {
        event_id: "$power",
        room_id: "!room:test",
        sender: "@creator:test",
        type: "m.room.power_levels",
        state_key: "",
        content: {},
        origin_server_ts: 2,
        depth: 2,
        auth_events: [],
        prev_events: [],
      },
      actorMembership: { membership: "join", eventId: "$alice-member" },
      targetMembership: { membership: "invite", eventId: "$invite" },
      targetMembershipEvent,
      latestEvents: [targetMembershipEvent],
    });

    expect(event.type).toBe("m.room.member");
    expect(event.state_key).toBe("@bob:test");
    expect(event.content).toEqual({ membership: "leave", reason: "cleanup" });
    expect(event.unsigned).toMatchObject({
      prev_content: { membership: "invite" },
      prev_sender: "@alice:test",
    });
  });
});
