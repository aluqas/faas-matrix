import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { runClientEffect } from "../../effect-runtime";
import { type ProfileCommandPorts } from "./command";
import {
  deleteCustomProfileKeyEffect,
  putCustomProfileKeyEffect,
  updateProfileFieldEffect,
} from "./command";

function createPorts(store: Record<string, unknown> = {}): ProfileCommandPorts {
  return {
    localServerName: "test",
    updateProfile: () => Effect.void,
    getStoredCustomProfile: () => Effect.succeed({ ...store }),
    putStoredCustomProfile: (_userId, value) =>
      Effect.sync(() => {
        Object.keys(store).forEach((key) => delete store[key]);
        Object.assign(store, value);
      }),
  };
}

describe("profile command", () => {
  it("forbids modifying another user's profile", async () => {
    const ports = createPorts();

    await expect(
      runClientEffect(
        updateProfileFieldEffect(ports, {
          authUserId: "@alice:test",
          targetUserId: "@bob:test",
          field: "displayname",
          value: "Bob",
        }),
      ),
    ).rejects.toMatchObject({
      errcode: "M_FORBIDDEN",
    });
  });

  it("rejects custom updates for standard profile keys", async () => {
    const ports = createPorts();

    await expect(
      runClientEffect(
        putCustomProfileKeyEffect(ports, {
          authUserId: "@alice:test",
          targetUserId: "@alice:test",
          keyName: "displayname",
          value: "Alice",
        }),
      ),
    ).rejects.toMatchObject({
      errcode: "M_UNRECOGNIZED",
    });
  });

  it("updates and deletes custom profile keys through stored JSON objects", async () => {
    const store: Record<string, unknown> = { "im.example.theme": "light" };
    const ports = createPorts(store);

    await runClientEffect(
      putCustomProfileKeyEffect(ports, {
        authUserId: "@alice:test",
        targetUserId: "@alice:test",
        keyName: "im.example.theme",
        value: "dark",
      }),
    );
    expect(store).toEqual({ "im.example.theme": "dark" });

    await runClientEffect(
      deleteCustomProfileKeyEffect(ports, {
        authUserId: "@alice:test",
        targetUserId: "@alice:test",
        keyName: "im.example.theme",
      }),
    );
    expect(store).toEqual({});
  });
});
