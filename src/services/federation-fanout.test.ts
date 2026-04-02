import { describe, expect, it } from "vitest";
import { collectRemoteServersForEvent } from "./federation-fanout";

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
