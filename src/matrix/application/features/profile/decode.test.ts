import { describe, expect, it } from "vitest";
import { runClientEffect } from "../../effect-runtime";
import { decodeProfileFieldUpdateInput, decodePutCustomProfileKeyInput } from "./decode";

describe("profile decode", () => {
  it("decodes displayname updates into exact profile field inputs", async () => {
    await expect(
      runClientEffect(
        decodeProfileFieldUpdateInput({
          authUserId: "@alice:test",
          targetUserId: "@alice:test",
          field: "displayname",
          body: { displayname: "Alice" },
        }),
      ),
    ).resolves.toEqual({
      authUserId: "@alice:test",
      targetUserId: "@alice:test",
      field: "displayname",
      value: "Alice",
    });
  });

  it("rejects invalid custom profile JSON values", async () => {
    await expect(
      runClientEffect(
        decodePutCustomProfileKeyInput({
          authUserId: "@alice:test",
          targetUserId: "@alice:test",
          keyName: "im.example.invalid",
          body: {},
        }),
      ),
    ).rejects.toMatchObject({
      errcode: "M_MISSING_PARAM",
    });
  });
});
