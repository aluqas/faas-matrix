import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { runClientEffect } from "../../matrix/application/runtime/effect-runtime";
import {
  type AccountDataQueryPorts,
  queryGlobalAccountDataEffect,
  queryRoomAccountDataEffect,
} from "./query";

function createPorts(overrides: Partial<AccountDataQueryPorts> = {}): AccountDataQueryPorts {
  return {
    accountDataReader: {
      getGlobalAccountData: () => Effect.succeed({ "@alice:test": ["!room:test"] }),
      getRoomAccountData: () => Effect.succeed({ tags: {} }),
    },
    membership: {
      isUserJoinedToRoom: () => Effect.succeed(true),
    },
    ...overrides,
  };
}

describe("account-data query effect", () => {
  it("returns global account data for the owning user", async () => {
    await expect(
      runClientEffect(
        queryGlobalAccountDataEffect(createPorts(), {
          authUserId: "@alice:test",
          targetUserId: "@alice:test",
          eventType: "m.direct",
        }),
      ),
    ).resolves.toEqual({ "@alice:test": ["!room:test"] });
  });

  it("rejects room account data when the user is not joined", async () => {
    await expect(
      runClientEffect(
        queryRoomAccountDataEffect(
          createPorts({
            membership: {
              isUserJoinedToRoom: () => Effect.succeed(false),
            },
          }),
          {
            authUserId: "@alice:test",
            targetUserId: "@alice:test",
            roomId: "!room:test",
            eventType: "m.tag",
          },
        ),
      ),
    ).rejects.toMatchObject({
      errcode: "M_FORBIDDEN",
    });
  });

  it("returns not found when the content is missing", async () => {
    await expect(
      runClientEffect(
        queryGlobalAccountDataEffect(
          createPorts({
            accountDataReader: {
              getGlobalAccountData: () => Effect.succeed(null),
              getRoomAccountData: () => Effect.succeed({ tags: {} }),
            },
          }),
          {
            authUserId: "@alice:test",
            targetUserId: "@alice:test",
            eventType: "m.direct",
          },
        ),
      ),
    ).rejects.toMatchObject({
      errcode: "M_NOT_FOUND",
    });
  });
});
