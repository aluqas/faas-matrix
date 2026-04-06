import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { runClientEffect } from "../../effect-runtime";
import { InfraError } from "../../domain-error";
import { queryCustomProfileKeyEffect, queryProfileEffect, type ProfileQueryPorts } from "./query";

function createPorts(overrides: Partial<ProfileQueryPorts> = {}): ProfileQueryPorts {
  return {
    localServerName: "test",
    getProfile: () =>
      Effect.succeed({
        displayname: "Alice",
        avatar_url: "mxc://test/alice",
      }),
    getLocalUserExists: () => Effect.succeed(true),
    getStoredCustomProfile: () =>
      Effect.succeed({
        "im.example.color": "blue",
      }),
    ...overrides,
  };
}

describe("profile query", () => {
  it("returns a not-found error when no profile exists", async () => {
    const ports = createPorts({
      getProfile: () => Effect.succeed(null),
    });

    await expect(
      runClientEffect(queryProfileEffect(ports, { userId: "@alice:test" })),
    ).rejects.toMatchObject({
      errcode: "M_NOT_FOUND",
    });
  });

  it("returns custom profile keys for local users", async () => {
    const ports = createPorts();

    await expect(
      runClientEffect(
        queryCustomProfileKeyEffect(ports, {
          targetUserId: "@alice:test",
          keyName: "im.example.color",
        }),
      ),
    ).resolves.toEqual({
      "im.example.color": "blue",
    });
  });

  it("rejects remote custom profile keys", async () => {
    const ports = createPorts();

    await expect(
      runClientEffect(
        queryCustomProfileKeyEffect(ports, {
          targetUserId: "@alice:remote.test",
          keyName: "im.example.color",
        }),
      ),
    ).rejects.toMatchObject({
      errcode: "M_NOT_FOUND",
    });
  });
});
