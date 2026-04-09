import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { runFederationEffect } from "../../matrix/application/runtime/effect-runtime";
import { queryFederationEventRelationshipsEffect } from "./relationships-query-effect";
import type { FederationQueryPorts } from "./query-shared";

function createPorts(
  result: Awaited<ReturnType<FederationQueryPorts["relationshipsReader"]["buildEventRelationships"]>> extends Effect.Effect<infer A, any>
    ? A
    : never,
): FederationQueryPorts {
  return {
    localServerName: "test",
    profileRepository: {
      getLocalProfile: () => Effect.succeed(null),
    },
    profileGateway: {
      fetchRemoteProfile: () => Effect.succeed(null),
    },
    roomDirectoryRepository: {
      findRoomIdByAlias: () => Effect.succeed(null),
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
      buildEventRelationships: () => Effect.succeed(result),
    },
  };
}

describe("federation relationships query effect", () => {
  it("returns the built event relationships response", async () => {
    await expect(
      runFederationEffect(
        queryFederationEventRelationshipsEffect(createPorts({
          events: [],
          limited: false,
          auth_chain: [],
        }), {
          eventId: "$event",
          direction: "down",
        }),
      ),
    ).resolves.toEqual({
      events: [],
      limited: false,
      auth_chain: [],
    });
  });

  it("returns not found when no relationships are available", async () => {
    await expect(
      runFederationEffect(
        queryFederationEventRelationshipsEffect(createPorts(null), {
          eventId: "$event",
          direction: "down",
        }),
      ),
    ).rejects.toMatchObject({
      errcode: "M_NOT_FOUND",
      status: 404,
    });
  });
});
