import { describe, expect, it } from "vitest";

import { calculateContentHash, verifyContentHash } from "./crypto";

describe("crypto content hashes", () => {
  it("produces unpadded base64 hashes for Matrix events", async () => {
    const event = {
      type: "m.room.name",
      room_id: "!room:test",
      sender: "@alice:test",
      state_key: "",
      content: {
        name: "I am the room name, S2",
      },
      origin: "remote.example",
      origin_server_ts: 1234,
      depth: 2,
      auth_events: ["$create:test"],
      prev_events: ["$prev:test"],
      prev_state: [],
    };

    const hash = await calculateContentHash(event);

    expect(hash).toContain("/");
    expect(hash).not.toContain("_");
    expect(hash).not.toContain("=");
  });

  it("verifies both standard and urlsafe unpadded base64 hashes", async () => {
    const event = {
      type: "m.room.name",
      room_id: "!room:test",
      sender: "@alice:test",
      state_key: "",
      content: {
        name: "I am the room name, S2",
      },
      origin: "remote.example",
      origin_server_ts: 1234,
      depth: 2,
      auth_events: ["$create:test"],
      prev_events: ["$prev:test"],
      prev_state: [],
    };

    const hash = await calculateContentHash(event);
    const urlsafeHash = hash.replace(/\+/g, "-").replace(/\//g, "_");

    expect(await verifyContentHash(event, hash)).toBe(true);
    expect(await verifyContentHash(event, urlsafeHash)).toBe(true);
  });
});
