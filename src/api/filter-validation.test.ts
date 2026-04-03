import { describe, expect, it } from "vitest";
import { validateFilterDefinition } from "./filter-validation";

describe("validateFilterDefinition", () => {
  it("accepts a valid filter shape", () => {
    expect(
      validateFilterDefinition({
        room: {
          rooms: ["!room:test"],
          timeline: {
            senders: ["@alice:test"],
            types: ["m.room.message"],
            limit: 10,
          },
        },
      }),
    ).toEqual({
      room: {
        rooms: ["!room:test"],
        timeline: {
          senders: ["@alice:test"],
          types: ["m.room.message"],
          limit: 10,
        },
      },
    });
  });

  it("rejects invalid nested filter field types and malformed ids", () => {
    expect(() =>
      validateFilterDefinition({
        room: {
          timeline: {
            rooms: "not-a-list",
          },
        },
      }),
    ).toThrow();

    expect(() =>
      validateFilterDefinition({
        room: {
          rooms: ["not_a_room_id"],
        },
      }),
    ).toThrow();

    expect(() =>
      validateFilterDefinition({
        room: {
          timeline: {
            senders: ["not_a_sender_id"],
          },
        },
      }),
    ).toThrow();
  });
});
