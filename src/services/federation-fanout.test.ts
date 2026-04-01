import { describe, expect, it } from "vitest";
import type { PDU } from "../types";
import { collectRemoteServersForEvent } from "./federation-fanout";

function createEvent(overrides: Partial<PDU>): PDU {
  return {
    event_id: "$event",
    room_id: "!room:test",
    sender: "@alice:test",
    type: "m.room.message",
    content: {},
    origin_server_ts: 1,
    depth: 1,
    auth_events: [],
    prev_events: [],
    ...overrides,
  };
}

describe("federation-fanout", () => {
  it("fans out ACL events to invited and knocked remote servers as well as joined servers", () => {
    const servers = collectRemoteServersForEvent(
      "test",
      "!room:test",
      createEvent({
        type: "m.room.server_acl",
        state_key: "",
        content: { allow: ["*"], deny: ["evil.example"] },
      }),
      [
        { user_id: "@joined:remote-a", membership: "join" },
        { user_id: "@invited:remote-b", membership: "invite" },
        { user_id: "@knocker:remote-c", membership: "knock" },
        { user_id: "@left:remote-d", membership: "leave" },
      ],
    );

    expect(servers.sort()).toEqual(["remote-a", "remote-b", "remote-c"]);
  });

  it("includes remote target and sender servers for membership propagation", () => {
    const servers = collectRemoteServersForEvent(
      "test",
      "!room:remote-room",
      createEvent({
        type: "m.room.member",
        state_key: "@bob:remote-target",
        sender: "@alice:remote-sender",
        content: { membership: "leave" },
      }),
      [{ user_id: "@joined:remote-joined", membership: "join" }],
    );

    expect(servers.sort()).toEqual([
      "remote-joined",
      "remote-room",
      "remote-sender",
      "remote-target",
    ]);
  });

  it("always includes the remote room server for non-membership events", () => {
    const servers = collectRemoteServersForEvent(
      "local",
      "!room:remote-host",
      createEvent({
        room_id: "!room:remote-host",
        sender: "@alice:local",
      }),
      [],
    );

    expect(servers).toEqual(["remote-host"]);
  });

  it("preserves explicit ports in remote room server names", () => {
    const servers = collectRemoteServersForEvent(
      "local",
      "!room:remote-host:8448",
      createEvent({
        room_id: "!room:remote-host:8448",
        sender: "@alice:local",
      }),
      [],
    );

    expect(servers).toEqual(["remote-host:8448"]);
  });

  it("can exclude the origin server from membership re-fanout", () => {
    const servers = collectRemoteServersForEvent(
      "hs1",
      "!room:remote-origin",
      createEvent({
        type: "m.room.member",
        sender: "@alice:remote-origin",
        state_key: "@alice:remote-origin",
        content: { membership: "join" },
      }),
      [{ user_id: "@bob:remote-peer", membership: "join" }],
      ["remote-origin"],
    );

    expect(servers).toEqual(["remote-peer"]);
  });
});
