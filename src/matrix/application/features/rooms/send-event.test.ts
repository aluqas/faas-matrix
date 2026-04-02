import { describe, expect, it } from "vitest";

import type { PDU } from "../../../../types";
import {
  assertOwnedStateEventAllowed,
  assertRedactionAllowed,
  buildRoomEvent,
  hasEquivalentStateEvent,
} from "./send-event";

describe("rooms send-event helpers", () => {
  it("detects equivalent state events from the same sender", () => {
    const existingStateEvent: PDU = {
      event_id: "$topic",
      room_id: "!room:test",
      sender: "@alice:test",
      type: "m.room.topic",
      state_key: "",
      content: { topic: "same" },
      origin_server_ts: 1,
      depth: 1,
      auth_events: [],
      prev_events: [],
    };

    expect(hasEquivalentStateEvent(existingStateEvent, "@alice:test", { topic: "same" })).toBe(
      true,
    );
    expect(hasEquivalentStateEvent(existingStateEvent, "@bob:test", { topic: "same" })).toBe(false);
  });

  it("rejects redactions of other users' events without sufficient power", () => {
    expect(() =>
      assertRedactionAllowed({
        powerLevelsEvent: {
          event_id: "$power",
          room_id: "!room:test",
          sender: "@creator:test",
          type: "m.room.power_levels",
          state_key: "",
          content: {
            redact: 50,
            users: {
              "@alice:test": 0,
            },
          },
          origin_server_ts: 1,
          depth: 1,
          auth_events: [],
          prev_events: [],
        },
        targetEvent: {
          event_id: "$message",
          room_id: "!room:test",
          sender: "@bob:test",
          type: "m.room.message",
          content: { body: "hi" },
          origin_server_ts: 2,
          depth: 2,
          auth_events: [],
          prev_events: [],
        },
        roomId: "!room:test",
        userId: "@alice:test",
      }),
    ).toThrow(/Insufficient power level/);
  });

  it("applies owned-state policy through the room command helper", () => {
    expect(() =>
      assertOwnedStateEventAllowed({
        roomVersion: "10",
        powerLevelsEvent: {
          event_id: "$power",
          room_id: "!room:test",
          sender: "@creator:test",
          type: "m.room.power_levels",
          state_key: "",
          content: {
            events: { "com.example.test": 0 },
            users: { "@alice:test": 0 },
            users_default: 0,
            state_default: 50,
          },
          origin_server_ts: 1,
          depth: 1,
          auth_events: [],
          prev_events: [],
        },
        eventType: "com.example.test",
        stateKey: "@bob:test",
        senderUserId: "@alice:test",
      }),
    ).toThrow(/reserved/);
  });

  it("builds a room event with auth and prev links", async () => {
    const event = await buildRoomEvent({
      roomId: "!room:test",
      userId: "@alice:test",
      roomVersion: "10",
      eventType: "m.room.message",
      txnId: "txn-1",
      content: { body: "hi", msgtype: "m.text" },
      membership: { membership: "join", eventId: "$member" },
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
        auth_events: ["$create"],
        prev_events: ["$create"],
      },
      latestEvents: [
        {
          event_id: "$prev",
          room_id: "!room:test",
          sender: "@alice:test",
          type: "m.room.message",
          content: { body: "before", msgtype: "m.text" },
          origin_server_ts: 3,
          depth: 3,
          auth_events: [],
          prev_events: [],
        },
      ],
      serverName: "test",
      generateEventId: async () => "$generated",
      now: () => 4,
    });

    expect(event.hashes?.sha256).toBeDefined();
    expect(event.auth_events).toEqual(["$create", "$power", "$member"]);
    expect(event.prev_events).toEqual(["$prev"]);
    expect(event.unsigned).toEqual({ transaction_id: "txn-1" });
  });
});
