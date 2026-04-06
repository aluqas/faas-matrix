import { describe, expect, it } from "vitest";

import {
  calculateContentHash,
  canonicalJson,
  decodeMatrixBase64,
  normalizeMatrixBase64,
  verifyContentHash,
} from "./crypto";

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
    const urlsafeHash = hash.replaceAll('+', "-").replaceAll('/', "_");

    expect(await verifyContentHash(event, hash)).toBe(true);
    expect(await verifyContentHash(event, urlsafeHash)).toBe(true);
  });

  it("decodes both standard and urlsafe unpadded base64 encodings", () => {
    const expected = new Uint8Array([251, 255, 255]);

    expect(decodeMatrixBase64("+///")).toEqual(expected);
    expect(decodeMatrixBase64("-___")).toEqual(expected);
  });

  it("normalizes urlsafe base64 into standard unpadded base64", () => {
    expect(normalizeMatrixBase64("-___")).toBe("+///");
  });

  it("produces different canonical JSON when event_id encoding changes", () => {
    const rawEvent = {
      event_id: "$abc+/def",
      type: "m.room.member",
      room_id: "!room:test",
      sender: "@alice:test",
      state_key: "@alice:test",
      content: {
        membership: "join",
      },
      origin: "test",
      origin_server_ts: 1234,
      depth: 2,
      auth_events: ["$create:test"],
      prev_events: ["$prev:test"],
    };

    expect(canonicalJson(rawEvent)).not.toBe(
      canonicalJson({
        ...rawEvent,
        event_id: "$abc-_def",
      }),
    );
  });
});
