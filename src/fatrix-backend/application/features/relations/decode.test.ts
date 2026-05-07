import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { decodeListRelationsInput } from "./decode";

const baseInput = {
  authUserId: "@alice:test.local",
  roomId: "!room:test.local",
  eventId: "$event:test.local",
};

async function runDecode(input: Parameters<typeof decodeListRelationsInput>[0]) {
  return Effect.runPromise(decodeListRelationsInput(input));
}

describe("decodeListRelationsInput – relation cursor parsing", () => {
  it("parses simple stream token s14 as stream_ordering=14", async () => {
    const result = await runDecode({ ...baseInput, from: "s14", dir: "f" });
    expect(result.cursor).toEqual({ column: "stream_ordering", value: 14 });
  });

  it("parses canonical sync token s14_td0_dk14 as stream_ordering=14", async () => {
    const result = await runDecode({ ...baseInput, from: "s14_td0_dk14", dir: "f" });
    expect(result.cursor).toEqual({ column: "stream_ordering", value: 14 });
  });

  it("parses numeric token as origin_server_ts", async () => {
    const result = await runDecode({ ...baseInput, from: "1700000000000", dir: "b" });
    expect(result.cursor).toEqual({ column: "origin_server_ts", value: 1700000000000 });
  });

  it("returns null cursor when from is omitted", async () => {
    const result = await runDecode({ ...baseInput });
    expect(result.cursor).toBeNull();
  });

  it("returns null cursor for unrecognised token format", async () => {
    const result = await runDecode({ ...baseInput, from: "invalid-token" });
    expect(result.cursor).toBeNull();
  });

  it("respects dir=f for forward pagination", async () => {
    const result = await runDecode({ ...baseInput, from: "s5", dir: "f" });
    expect(result.dir).toBe("f");
  });

  it("defaults dir to b when not specified", async () => {
    const result = await runDecode({ ...baseInput });
    expect(result.dir).toBe("b");
  });
});
