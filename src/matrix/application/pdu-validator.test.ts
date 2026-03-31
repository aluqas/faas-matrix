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
});
