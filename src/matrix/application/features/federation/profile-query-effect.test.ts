import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { runFederationEffect } from "../../effect-runtime";
import { queryFederationProfileEffect } from "./profile-query-effect";
import type { FederationQueryPorts } from "./query-shared";

function createPorts(overrides: Partial<FederationQueryPorts> = {}): FederationQueryPorts {
  return {
    localServerName: "test",
    profileRepository: {
      getLocalProfile: () => Effect.succeed({ displayname: "Local", avatar_url: null }),
    },
    profileGateway: {
      fetchRemoteProfile: () => Effect.succeed({ displayname: "Remote", avatar_url: null }),
    },
    roomDirectoryRepository: {
      findRoomIdByAlias: () => Effect.succeed("!room:test"),
    },
    serverKeysRepository: {
      getCurrentServerKeys: () => Effect.succeed([]),
    },
    notaryGateway: {
      getSigningKey: () => Effect.succeed(null),
      getNotarizedServerKeys: () => Effect.succeed([]),
      signResponse: (response) => Effect.succeed(response),
    },
    relationshipsReader: {
      buildEventRelationships: () => Effect.succeed(null),
    },
    ...overrides,
  };
}

describe("federation profile query effect", () => {
  it("uses the local repository for local users", async () => {
    await expect(
      runFederationEffect(
        queryFederationProfileEffect(createPorts(), {
          userId: "@alice:test",
        }),
      ),
    ).resolves.toEqual({
      displayname: "Local",
      avatar_url: null,
    });
  });

  it("uses the remote gateway for remote users", async () => {
    await expect(
      runFederationEffect(
        queryFederationProfileEffect(createPorts(), {
          userId: "@alice:remote.test",
          field: "displayname",
        }),
      ),
    ).resolves.toEqual({
      displayname: "Remote",
      avatar_url: null,
    });
  });
});
