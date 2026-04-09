import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { runFederationEffect } from "../../matrix/application/runtime/effect-runtime";
import { resolveFederationDirectoryEffect } from "./directory-query-effect";
import type { FederationQueryPorts } from "./query-shared";

const ports: FederationQueryPorts = {
  localServerName: "test",
  profileRepository: {
    getLocalProfile: () => Effect.succeed(null),
  },
  profileGateway: {
    fetchRemoteProfile: () => Effect.succeed(null),
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
};

describe("federation directory query effect", () => {
  it("returns the resolved room id and local server", async () => {
    await expect(
      runFederationEffect(
        resolveFederationDirectoryEffect(ports, {
          roomAlias: "#alias:test",
        }),
      ),
    ).resolves.toEqual({
      room_id: "!room:test",
      servers: ["test"],
    });
  });
});
