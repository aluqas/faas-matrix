import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { runFederationEffect } from "../../effect-runtime";
import {
  MAX_BATCH_SERVERS,
  queryFederationEventRelationshipsEffect,
  queryFederationProfileEffect,
  queryFederationServerKeysBatchEffect,
  queryFederationServerKeysEffect,
  resolveFederationDirectoryEffect,
  type FederationQueryPorts,
} from "./query";

function createPorts(overrides: Partial<FederationQueryPorts> = {}): FederationQueryPorts {
  return {
    localServerName: "test",
    getProfile: () =>
      Effect.succeed({
        displayname: "Alice",
        avatar_url: "mxc://test/alice",
      }),
    getRoomByAlias: () => Effect.succeed("!room:test"),
    getNotarySigningKey: () =>
      Effect.succeed({
        keyId: "ed25519:test",
        privateKeyJwk: {} as JsonWebKey,
      }),
    getCurrentServerKeys: () =>
      Effect.succeed([
        {
          keyId: "ed25519:test",
          publicKey: "dGVzdA",
          validUntil: 123,
        },
      ]),
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
    signNotaryResponse: (response) =>
      Effect.succeed({
        ...response,
        signatures: { test: { "ed25519:test": "sig" } },
      }),
    buildEventRelationships: () =>
      Effect.succeed({
        events: [],
        limited: false,
        auth_chain: [],
      }),
    ...overrides,
  };
}

describe("federation query effect", () => {
  it("rejects invalid federation profile user IDs before querying", async () => {
    await expect(
      runFederationEffect(
        queryFederationProfileEffect(createPorts(), {
          userId: "alice" as unknown as `@${string}:${string}`,
        }),
      ),
    ).rejects.toMatchObject({
      errcode: "M_INVALID_PARAM",
      status: 400,
    });
  });

  it("resolves local directory aliases through the shared query ports", async () => {
    await expect(
      runFederationEffect(
        resolveFederationDirectoryEffect(createPorts(), {
          roomAlias: "#alias:test",
        }),
      ),
    ).resolves.toEqual({
      room_id: "!room:test",
      servers: ["test"],
    });
  });

  it("shares local notary signing and remote key fetch logic for batch queries", async () => {
    const remoteCalls: Array<{
      serverName: string;
      keyId: string | null;
      minimumValidUntilTs: number;
    }> = [];
    const ports = createPorts({
      getNotarizedServerKeys: (serverName, keyId, minimumValidUntilTs) => {
        remoteCalls.push({ serverName, keyId, minimumValidUntilTs });
        return Effect.succeed([
          {
            server_name: serverName,
            valid_until_ts: minimumValidUntilTs || 1,
            verify_keys: keyId
              ? { [keyId]: { key: "cmVtb3Rl" } }
              : { "ed25519:remote": { key: "cmVtb3Rl" } },
            old_verify_keys: {},
          },
        ]);
      },
    });

    const result = await runFederationEffect(
      queryFederationServerKeysBatchEffect(ports, {
        serverKeys: {
          test: {
            "": {},
          },
          "remote.example": {
            "": { minimum_valid_until_ts: 5 },
            "ed25519:remote": { minimum_valid_until_ts: 9 },
          },
          localhost: {
            "": {},
          },
        },
      }),
    );

    expect(result.map((response) => response.server_name)).toEqual([
      "test",
      "remote.example",
      "remote.example",
    ]);
    expect(result[0]?.signatures).toEqual({ test: { "ed25519:test": "sig" } });
    expect(remoteCalls).toEqual([
      {
        serverName: "remote.example",
        keyId: null,
        minimumValidUntilTs: 5,
      },
      {
        serverName: "remote.example",
        keyId: "ed25519:remote",
        minimumValidUntilTs: 9,
      },
    ]);
  });

  it("returns not found when a specific remote server key is unavailable", async () => {
    const ports = createPorts({
      getNotarizedServerKeys: () => Effect.succeed([]),
    });

    await expect(
      runFederationEffect(
        queryFederationServerKeysEffect(ports, {
          serverName: "remote.example",
          keyId: "ed25519:missing",
        }),
      ),
    ).rejects.toMatchObject({
      errcode: "M_NOT_FOUND",
      status: 404,
      message: "Key not found",
    });
  });

  it("enforces the batch server limit inside the use-case", async () => {
    const serverKeys = Object.fromEntries(
      Array.from({ length: MAX_BATCH_SERVERS + 1 }, (_, index) => [
        `remote-${index}.example`,
        { "": {} },
      ]),
    );

    await expect(
      runFederationEffect(
        queryFederationServerKeysBatchEffect(createPorts(), {
          serverKeys,
        }),
      ),
    ).rejects.toMatchObject({
      errcode: "M_LIMIT_EXCEEDED",
      status: 400,
    });
  });

  it("routes unstable event_relationships through the shared effect path", async () => {
    await expect(
      runFederationEffect(
        queryFederationEventRelationshipsEffect(createPorts(), {
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
});
