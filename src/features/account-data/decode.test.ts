import { describe, expect, it } from "vitest";
import { runClientEffect } from "../../matrix/application/runtime/effect-runtime";
import {
  decodeGetGlobalAccountDataInput,
  decodePutGlobalAccountDataInput,
  decodePutRoomAccountDataInput,
} from "./decode";

describe("account-data decode", () => {
  it("decodes global account-data input", async () => {
    await expect(
      runClientEffect(
        decodeGetGlobalAccountDataInput({
          authUserId: "@alice:test",
          targetUserId: "@alice:test",
          eventType: "m.direct",
        }),
      ),
    ).resolves.toEqual({
      authUserId: "@alice:test",
      targetUserId: "@alice:test",
      eventType: "m.direct",
    });
  });

  it("rejects non-object account-data bodies", async () => {
    await expect(
      runClientEffect(
        decodePutGlobalAccountDataInput({
          authUserId: "@alice:test",
          targetUserId: "@alice:test",
          eventType: "m.direct",
          body: ["not-an-object"],
        }),
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("expected a JSON object"),
    });
  });

  it("decodes room account-data input", async () => {
    await expect(
      runClientEffect(
        decodePutRoomAccountDataInput({
          authUserId: "@alice:test",
          targetUserId: "@alice:test",
          roomId: "!room:test",
          eventType: "m.tag",
          body: { tags: {} },
        }),
      ),
    ).resolves.toEqual({
      authUserId: "@alice:test",
      targetUserId: "@alice:test",
      roomId: "!room:test",
      eventType: "m.tag",
      content: { tags: {} },
    });
  });
});
