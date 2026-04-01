import { describe, expect, it } from "vitest";

import { tryValidateIncomingPdu } from "./pdu-validator";

describe("pdu-validator", () => {
  it("derives event_id for room v10 PDUs without event_id", async () => {
    const event = await tryValidateIncomingPdu(
      {
        room_id: "!room:test",
        sender: "@alice:test",
        type: "m.room.create",
        state_key: "",
        content: {
          creator: "@alice:test",
          room_version: "10",
        },
        origin_server_ts: 1,
        depth: 1,
        auth_events: [],
        prev_events: [],
        hashes: {
          sha256: "dummy",
        },
      },
      "state",
      "10",
    );

    expect(event?.event_id).toMatch(/^\$/);
    expect(event?.type).toBe("m.room.create");
  });

  it("preserves federation-only top-level fields used by room v10 reference hashes", async () => {
    const event = await tryValidateIncomingPdu(
      {
        room_id: "!room:test",
        sender: "@alice:remote.test",
        type: "m.room.member",
        state_key: "@alice:remote.test",
        origin: "remote.test",
        membership: "join",
        prev_state: ["$prev:test"],
        content: {
          membership: "join",
        },
        origin_server_ts: 1,
        depth: 2,
        auth_events: ["$create:test"],
        prev_events: ["$prev:test"],
        hashes: {
          sha256: "dummy",
        },
      },
      "state",
      "10",
    );

    expect(event?.origin).toBe("remote.test");
    expect(event?.membership).toBe("join");
    expect(event?.prev_state).toEqual(["$prev:test"]);
  });

  it("rejects room v1 PDUs without event_id", async () => {
    const event = await tryValidateIncomingPdu(
      {
        room_id: "!room:test",
        sender: "@alice:test",
        type: "m.room.message",
        content: {
          body: "hi",
          msgtype: "m.text",
        },
        origin_server_ts: 1,
      },
      "state",
      "1",
    );

    expect(event).toBeNull();
  });

  it("rejects non-integer canonical JSON numbers for room v6+", async () => {
    const event = await tryValidateIncomingPdu(
      {
        event_id: "$bad:test",
        room_id: "!room:test",
        sender: "@alice:test",
        type: "m.room.message",
        content: {
          body: "hi",
          bad_val: 1.1,
        },
        origin_server_ts: 1,
        depth: 2,
        auth_events: ["$create:test"],
        prev_events: ["$prev:test"],
      },
      "state",
      "10",
    );

    expect(event).toBeNull();
  });
});
