import { describe, expect, it } from "vitest";
import {
  extractRawFederationPduFields,
  getRoomScopedEduRoomIds,
  toRawFederationEdu,
  toRawFederationPdu,
} from "./contracts";

describe("federation contracts", () => {
  it("extracts typed PDU fields from unknown records", () => {
    const pdu = toRawFederationPdu({
      event_id: "$event",
      room_id: "!room:test",
      sender: "@alice:test",
      type: "m.room.message",
      state_key: "",
      content: { body: "hi" },
    });

    expect(extractRawFederationPduFields(pdu)).toEqual({
      roomId: "!room:test",
      sender: "@alice:test",
      eventType: "m.room.message",
      eventId: "$event",
      stateKey: "",
      content: { body: "hi" },
    });
  });

  it("extracts typed EDU envelopes", () => {
    const edu = toRawFederationEdu({
      edu_type: "m.typing",
      content: { room_id: "!room:test" },
    });

    expect(edu.edu_type).toBe("m.typing");
    expect(edu.content).toEqual({ room_id: "!room:test" });
  });

  it("returns room scoped ids for room-local EDUs", () => {
    expect(getRoomScopedEduRoomIds("m.typing", { room_id: "!room:test" })).toEqual(["!room:test"]);
    expect(
      getRoomScopedEduRoomIds("m.receipt", {
        "!room:test": {},
        "!room2:test": {},
      }),
    ).toEqual(["!room:test", "!room2:test"]);
  });
});
