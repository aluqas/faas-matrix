import { describe, expect, it } from "vitest";
import type { PDU } from "../../types";
import { createInitialRoomEvents } from "./rooms-support";

describe("createInitialRoomEvents", () => {
  it("omits guest access for public_chat and enables it for private_chat", async () => {
    const storedEvents: PDU[] = [];
    const repository = {
      async storeEvent(event: PDU) {
        storedEvents.push(event);
      },
      async updateMembership() {},
    } as {
      storeEvent(event: PDU): Promise<void>;
      updateMembership(): Promise<void>;
    };

    await createInitialRoomEvents(
      repository as never,
      "hs1",
      "!room:hs1",
      "10",
      "@alice:hs1",
      { preset: "public_chat" },
      async () => "$unused",
      () => 1,
    );

    expect(storedEvents.some((event) => event.type === "m.room.guest_access")).toBe(false);

    storedEvents.length = 0;

    await createInitialRoomEvents(
      repository as never,
      "hs1",
      "!room:hs1",
      "10",
      "@alice:hs1",
      { preset: "private_chat" },
      async () => "$unused",
      () => 1,
    );

    const guestAccessEvent = storedEvents.find((event) => event.type === "m.room.guest_access");
    expect(guestAccessEvent?.content).toEqual({ guest_access: "can_join" });
  });

  it("preserves creation_content on the m.room.create event", async () => {
    const storedEvents: PDU[] = [];
    const repository = {
      async storeEvent(event: PDU) {
        storedEvents.push(event);
      },
      async updateMembership() {},
    } as {
      storeEvent(event: PDU): Promise<void>;
      updateMembership(): Promise<void>;
    };

    await createInitialRoomEvents(
      repository as never,
      "hs1",
      "!room:hs1",
      "10",
      "@alice:hs1",
      { creation_content: { "m.federate": false } },
      async () => "$unused",
      () => 1,
    );

    const createEvent = storedEvents.find((event) => event.type === "m.room.create");
    expect(createEvent?.content).toMatchObject({
      creator: "@alice:hs1",
      room_version: "10",
      "m.federate": false,
    });
  });
});
