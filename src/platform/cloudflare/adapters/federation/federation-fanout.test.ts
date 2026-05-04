import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  collectRemoteServersForEvent,
  fanoutEventToRemoteServersWithPorts,
} from "./federation-fanout";

describe("collectRemoteServersForEvent", () => {
  it("does not echo membership events back to servers that already signed them", () => {
    expect(
      collectRemoteServersForEvent(
        "hs1",
        "!room:hs1",
        {
          event_id: "$join",
          room_id: "!room:hs1",
          sender: "@elsie:hs2",
          type: "m.room.member",
          state_key: "@elsie:hs2",
          content: { membership: "join" },
          origin_server_ts: 1,
          depth: 1,
          auth_events: [],
          prev_events: [],
          signatures: {
            hs2: {
              "ed25519:key": "sig",
            },
          },
        },
        [
          { user_id: "@alice:hs1", membership: "join" },
          { user_id: "@elsie:hs2", membership: "join" },
        ],
        ["hs1"],
      ),
    ).toEqual([]);
  });

  it("still fans out to other remote servers that did not sign the event", () => {
    expect(
      collectRemoteServersForEvent(
        "hs1",
        "!room:hs1",
        {
          event_id: "$join",
          room_id: "!room:hs1",
          sender: "@elsie:hs2",
          type: "m.room.member",
          state_key: "@elsie:hs2",
          content: { membership: "join" },
          origin_server_ts: 1,
          depth: 1,
          auth_events: [],
          prev_events: [],
          signatures: {
            hs2: {
              "ed25519:key": "sig",
            },
          },
        },
        [
          { user_id: "@alice:hs1", membership: "join" },
          { user_id: "@elsie:hs2", membership: "join" },
          { user_id: "@charlie:hs3", membership: "join" },
        ],
        ["hs1"],
      ),
    ).toEqual(["hs3"]);
  });
});

describe("fanoutEventToRemoteServersWithPorts", () => {
  it("uses injected ports for outbound delivery", async () => {
    const sends: Array<{
      destination: string;
      eventId: string;
      roomId: string;
      pdu: Record<string, unknown>;
    }> = [];
    const db = {
      prepare(query: string) {
        const normalizedQuery = query.replaceAll(/\s+/g, " ").trim();

        return {
          bind: () => ({
            first: <T>() => {
              if (normalizedQuery.includes("rs.event_type = 'm.room.server_acl'")) {
                return null as T | null;
              }
              return null as T | null;
            },
            all: <T>() => {
              if (normalizedQuery.includes("WITH current_memberships AS")) {
                return {
                  results: [
                    { user_id: "@alice:hs1", membership: "join" },
                    { user_id: "@bob:hs2", membership: "join" },
                  ] as T[],
                };
              }
              return { results: [] as T[] };
            },
          }),
        };
      },
    } as unknown as D1Database;

    await fanoutEventToRemoteServersWithPorts(
      {
        now: () => 123,
        runEffect: Effect.runPromise,
        async enqueuePdu(input) {
          sends.push(input);
        },
      },
      db,
      "hs1",
      "!room:hs1",
      {
        event_id: "$message:hs1",
        room_id: "!room:hs1",
        sender: "@alice:hs1",
        type: "m.room.message",
        content: { body: "hi" },
        origin_server_ts: 1,
        depth: 1,
        auth_events: [],
        prev_events: [],
      },
    );

    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({
      destination: "hs2",
      eventId: "$message:hs1",
      roomId: "!room:hs1",
    });
    expect(sends[0].pdu).toMatchObject({
      event_id: "$message:hs1",
      type: "m.room.message",
    });
  });
});
