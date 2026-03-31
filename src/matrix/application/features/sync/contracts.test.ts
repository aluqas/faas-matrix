import { describe, expect, it } from "vitest";
import { buildSyncToken, parseSyncToken, summarizeSyncResponse } from "./contracts";

describe("sync contracts", () => {
  it("parses composite sync tokens", () => {
    expect(parseSyncToken("s42_td9_dk12")).toEqual({ events: 42, toDevice: 9, deviceKeys: 12 });
    expect(parseSyncToken("s42_td9")).toEqual({ events: 42, toDevice: 9, deviceKeys: 42 });
    expect(parseSyncToken("17")).toEqual({ events: 17, toDevice: 17, deviceKeys: 17 });
    expect(parseSyncToken(undefined)).toEqual({ events: 0, toDevice: 0, deviceKeys: 0 });
  });

  it("builds composite sync tokens", () => {
    expect(buildSyncToken(5, 8, 13)).toBe("s5_td8_dk13");
  });

  it("summarizes response counts", () => {
    expect(
      summarizeSyncResponse({
        next_batch: "s10_td4_dk7",
        rooms: {
          join: { "!a:test": { timeline: { events: [] } } },
          invite: { "!b:test": {} },
          leave: {},
          knock: { "!c:test": {} },
        },
        presence: {
          events: [{ type: "m.presence", sender: "@a:test", content: { presence: "online" } }],
        },
        account_data: { events: [{ type: "m.direct", content: {} }] },
        to_device: { events: [{ sender: "@a:test", type: "m.room_key", content: {} }] },
        device_lists: { changed: ["@a:test"], left: [] },
      }),
    ).toEqual({
      joinedRoomCount: 1,
      inviteRoomCount: 1,
      leaveRoomCount: 0,
      knockRoomCount: 1,
      toDeviceCount: 1,
      accountDataCount: 1,
      presenceCount: 1,
      deviceListChangedCount: 1,
      deviceListLeftCount: 0,
    });
  });
});
