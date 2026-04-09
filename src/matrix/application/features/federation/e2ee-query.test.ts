import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { runFederationEffect } from "../../effect-runtime";
import {
  claimFederationOneTimeKeysEffect,
  queryFederationDeviceKeysEffect,
  queryFederationUserDevicesEffect,
  type FederationE2EEQueryPorts,
} from "./e2ee-query";

function createPorts(overrides: Partial<FederationE2EEQueryPorts> = {}): FederationE2EEQueryPorts {
  return {
    localServerName: "test",
    identityRepository: {
      localUserExists: () => Effect.succeed(true),
      listStoredDevices: () =>
        Effect.succeed([
          {
            deviceId: "DEVICE",
            displayName: "Alice phone",
          },
        ]),
      getDeviceKeyStreamId: () => Effect.succeed(7),
    },
    deviceKeysGateway: {
      getAllDeviceKeys: () =>
        Effect.succeed({
          DEVICE: {
            user_id: "@alice:test",
            device_id: "DEVICE",
            keys: { "ed25519:DEVICE": "pub" },
          },
        }),
      getDeviceKey: (_userId, deviceId) =>
        Effect.succeed({
          user_id: "@alice:test",
          device_id: deviceId,
        }),
      getCrossSigningKeys: () =>
        Effect.succeed({
          master: {
            user_id: "@alice:test",
            usage: ["master"],
            keys: { "ed25519:master": "pub" },
          },
        }),
    },
    signaturesRepository: {
      listDeviceSignatures: () =>
        Effect.succeed([
          {
            signerUserId: "@alice:test",
            signerKeyId: "ed25519:DEVICE",
            signature: "sig",
          },
        ]),
    },
    oneTimeKeyStore: {
      claimStoredOneTimeKey: () => Effect.succeed(null),
      claimDatabaseOneTimeKey: () => Effect.succeed(null),
      claimFallbackKey: () => Effect.succeed(null),
    },
    ...overrides,
  };
}

describe("federation e2ee query effect", () => {
  it("queries local device keys and merges signatures", async () => {
    const response = await runFederationEffect(
      queryFederationDeviceKeysEffect(createPorts(), {
        requestedKeys: { "@alice:test": [] },
      }),
    );

    expect(response.device_keys["@alice:test"]?.DEVICE?.signatures?.["@alice:test"]).toEqual({
      "ed25519:DEVICE": "sig",
    });
    expect(response.master_keys?.["@alice:test"]?.usage).toEqual(["master"]);
  });

  it("claims stored then database then fallback one-time keys", async () => {
    const response = await runFederationEffect(
      claimFederationOneTimeKeysEffect(
        createPorts({
          oneTimeKeyStore: {
            claimStoredOneTimeKey: (_userId, deviceId) =>
              deviceId === "DEVICE1"
                ? Effect.succeed({ keyId: "signed_curve25519:AAA", keyData: { key: "a" } })
                : Effect.succeed(null),
            claimDatabaseOneTimeKey: (_userId, deviceId) =>
              deviceId === "DEVICE2"
                ? Effect.succeed({ keyId: "signed_curve25519:BBB", keyData: { key: "b" } })
                : Effect.succeed(null),
            claimFallbackKey: (_userId, deviceId) =>
              deviceId === "DEVICE3"
                ? Effect.succeed({ keyId: "signed_curve25519:CCC", keyData: { key: "c" } })
                : Effect.succeed(null),
          },
        }),
        {
          requestedKeys: {
            "@alice:test": {
              DEVICE1: "signed_curve25519",
              DEVICE2: "signed_curve25519",
              DEVICE3: "signed_curve25519",
            },
          },
        },
      ),
    );

    expect(response.one_time_keys["@alice:test"]?.DEVICE1).toEqual({
      "signed_curve25519:AAA": { key: "a" },
    });
    expect(response.one_time_keys["@alice:test"]?.DEVICE2).toEqual({
      "signed_curve25519:BBB": { key: "b" },
    });
    expect(response.one_time_keys["@alice:test"]?.DEVICE3).toEqual({
      "signed_curve25519:CCC": { key: "c", fallback: true },
    });
  });

  it("returns user devices for a local user", async () => {
    const response = await runFederationEffect(
      queryFederationUserDevicesEffect(createPorts(), {
        userId: "@alice:test",
      }),
    );

    expect(response).toEqual({
      user_id: "@alice:test",
      stream_id: 7,
      devices: [
        {
          device_id: "DEVICE",
          device_display_name: "Alice phone",
          keys: {
            user_id: "@alice:test",
            device_id: "DEVICE",
            keys: { "ed25519:DEVICE": "pub" },
          },
        },
      ],
      master_key: {
        user_id: "@alice:test",
        usage: ["master"],
        keys: { "ed25519:master": "pub" },
      },
    });
  });
});
