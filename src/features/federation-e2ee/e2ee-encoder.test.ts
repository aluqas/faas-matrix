import { describe, expect, it } from "vitest";
import {
  encodeClientKeysChangesResponse,
  encodeClientKeysClaimResponse,
  encodeClientKeysQueryResponse,
  encodeClientKeysSignaturesUploadResponse,
  encodeFederationKeysClaimResponse,
  encodeFederationKeysQueryResponse,
  encodeFederationUserDevicesResponse,
} from "./e2ee-encoder";

describe("federation e2ee encoder", () => {
  it("encodes federation responses without changing shape", () => {
    expect(
      encodeFederationKeysQueryResponse({
        device_keys: { "@alice:test": { DEVICE: { user_id: "@alice:test", device_id: "DEVICE" } } },
      }),
    ).toEqual({
      device_keys: { "@alice:test": { DEVICE: { user_id: "@alice:test", device_id: "DEVICE" } } },
    });

    expect(
      encodeFederationKeysClaimResponse({
        one_time_keys: { "@alice:test": { DEVICE: { "signed_curve25519:AAA": { key: "a" } } } },
      }),
    ).toEqual({
      one_time_keys: { "@alice:test": { DEVICE: { "signed_curve25519:AAA": { key: "a" } } } },
    });

    expect(
      encodeFederationUserDevicesResponse({
        user_id: "@alice:test",
        stream_id: 1,
        devices: [],
      }),
    ).toEqual({
      user_id: "@alice:test",
      stream_id: 1,
      devices: [],
    });
  });

  it("encodes client keys responses", () => {
    expect(
      encodeClientKeysQueryResponse({
        deviceKeys: { "@alice:test": { DEVICE: { user_id: "@alice:test", device_id: "DEVICE" } } },
        masterKeys: {},
        selfSigningKeys: {},
        userSigningKeys: {},
        failures: {},
      }),
    ).toEqual({
      device_keys: { "@alice:test": { DEVICE: { user_id: "@alice:test", device_id: "DEVICE" } } },
      master_keys: {},
      self_signing_keys: {},
      user_signing_keys: {},
      failures: {},
    });

    expect(
      encodeClientKeysClaimResponse(
        { "@alice:test": { DEVICE: { "signed_curve25519:AAA": { key: "a" } } } },
        {},
      ),
    ).toEqual({
      one_time_keys: { "@alice:test": { DEVICE: { "signed_curve25519:AAA": { key: "a" } } } },
      failures: {},
    });

    expect(encodeClientKeysChangesResponse(["@alice:test"], ["@bob:test"])).toEqual({
      changed: ["@alice:test"],
      left: ["@bob:test"],
    });

    expect(
      encodeClientKeysSignaturesUploadResponse({
        "@alice:test": {
          DEVICE: { errcode: "M_UNKNOWN", error: "boom" },
        },
      }),
    ).toEqual({
      failures: {
        "@alice:test": {
          DEVICE: { errcode: "M_UNKNOWN", error: "boom" },
        },
      },
    });
  });
});
