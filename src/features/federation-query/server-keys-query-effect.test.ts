import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { runFederationEffect } from "../../matrix/application/runtime/effect-runtime";
import {
  queryFederationServerKeysBatchEffect,
  queryFederationServerKeysEffect,
} from "./server-keys-query-effect";
import type { FederationQueryPorts } from "./query-shared";

function createPorts(overrides: Partial<FederationQueryPorts> = {}): FederationQueryPorts {
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
      getCurrentServerKeys: () =>
        Effect.succeed([
          {
            keyId: "ed25519:test",
            publicKey: "dGVzdA",
            validUntil: 123,
          },
        ]),
    },
    notaryGateway: {
      getSigningKey: () =>
        Effect.succeed({
          keyId: "ed25519:test",
          privateKeyJwk: {} as JsonWebKey,
        }),
      getNotarizedServerKeys: (serverName, keyId, minimumValidUntilTs) =>
        Effect.succeed([
          {
            server_name: serverName,
            valid_until_ts: minimumValidUntilTs || 1,
            verify_keys: keyId
              ? { [keyId]: { key: "cmVtb3Rl" } }
              : { "ed25519:remote": { key: "cmVtb3Rl" } },
            old_verify_keys: {},
          },
        ]),
      signResponse: (response) => Effect.succeed(response),
    },
    relationshipsReader: {
      buildEventRelationships: () => Effect.succeed(null),
    },
    ...overrides,
  };
}

describe("federation server keys query effect", () => {
  it("returns local server keys for the local server", async () => {
    await expect(
      runFederationEffect(
        queryFederationServerKeysEffect(createPorts(), {
          serverName: "test",
        }),
      ),
    ).resolves.toHaveLength(1);
  });

  it("queries remote server keys in batch mode", async () => {
    await expect(
      runFederationEffect(
        queryFederationServerKeysBatchEffect(createPorts(), {
          serverKeys: {
            "remote.example": {
              "ed25519:remote": { minimum_valid_until_ts: 9 },
            },
          },
        }),
      ),
    ).resolves.toEqual([
      {
        server_name: "remote.example",
        valid_until_ts: 9,
        verify_keys: { "ed25519:remote": { key: "cmVtb3Rl" } },
        old_verify_keys: {},
      },
    ]);
  });
});
