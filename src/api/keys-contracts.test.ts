import { describe, expect, it } from "vitest";
import {
  isIdempotentCrossSigningUpload,
  parseCrossSigningKeysStore,
  parseCrossSigningUploadRequest,
  parseDeviceKeysMap,
  parseDeviceKeysPayload,
  parseJsonObject,
  parseKeysClaimRequest,
  parseKeysQueryRequest,
  parseKeysQueryResponse,
  parseKeysUploadRequest,
  parseSignaturesUploadRequest,
  parseStoredOneTimeKeyBuckets,
  parseTokenSubmitRequest,
  parseUiaSessionData,
} from "./keys-contracts";

describe("keys contracts", () => {
  it("parses upload requests", () => {
    expect(
      parseKeysUploadRequest({
        device_keys: { user_id: "@alice:test", device_id: "DEVICE" },
        one_time_keys: { "signed_curve25519:key": { key: "abc" } },
      }),
    ).toEqual({
      device_keys: { user_id: "@alice:test", device_id: "DEVICE" },
      one_time_keys: { "signed_curve25519:key": { key: "abc" } },
    });
  });

  it("rejects invalid query and claim payloads", () => {
    expect(parseKeysQueryRequest({ device_keys: { "@alice:test": ["A"] } })).toEqual({
      device_keys: { "@alice:test": ["A"] },
    });
    expect(parseKeysQueryRequest({ device_keys: { "@alice:test": [1] } })).toBeNull();

    expect(
      parseKeysQueryResponse({
        device_keys: {
          "@alice:test": {
            DEVICE: {
              user_id: "@alice:test",
              device_id: "DEVICE",
              algorithms: ["m.olm.v1.curve25519-aes-sha2"],
            },
          },
        },
        master_keys: {
          "@alice:test": {
            user_id: "@alice:test",
            usage: ["master"],
            keys: { "ed25519:master": "pub" },
          },
        },
      }),
    ).toEqual({
      device_keys: {
        "@alice:test": {
          DEVICE: {
            user_id: "@alice:test",
            device_id: "DEVICE",
            algorithms: ["m.olm.v1.curve25519-aes-sha2"],
          },
        },
      },
      master_keys: {
        "@alice:test": {
          user_id: "@alice:test",
          usage: ["master"],
          keys: { "ed25519:master": "pub" },
        },
      },
    });
    expect(parseKeysQueryResponse({ device_keys: { "@alice:test": { DEVICE: 1 } } })).toBeNull();

    expect(
      parseKeysClaimRequest({ one_time_keys: { "@alice:test": { DEVICE: "signed_curve25519" } } }),
    ).toEqual({
      one_time_keys: { "@alice:test": { DEVICE: "signed_curve25519" } },
    });
    expect(parseKeysClaimRequest({ one_time_keys: { "@alice:test": { DEVICE: 1 } } })).toBeNull();
  });

  it("parses cross-signing upload payloads and stored OTK buckets", () => {
    expect(
      parseCrossSigningUploadRequest({
        master_key: { user_id: "@alice:test", keys: { key: "value" } },
        auth: { type: "m.login.password", password: "secret" },
      }),
    ).toEqual({
      master_key: { user_id: "@alice:test", keys: { key: "value" } },
      auth: { type: "m.login.password", password: "secret" },
    });

    expect(
      parseStoredOneTimeKeyBuckets({
        signed_curve25519: [
          { keyId: "signed_curve25519:AAA", keyData: { key: "abc" }, claimed: false },
        ],
      }),
    ).toEqual({
      signed_curve25519: [
        { keyId: "signed_curve25519:AAA", keyData: { key: "abc" }, claimed: false },
      ],
    });
  });

  it("parses device key and cross-signing storage payloads", () => {
    expect(
      parseDeviceKeysPayload({
        user_id: "@alice:test",
        device_id: "DEVICE",
        algorithms: ["m.olm.v1.curve25519-aes-sha2"],
        keys: { "curve25519:DEVICE": "pub" },
        signatures: { "@alice:test": { "ed25519:DEVICE": "sig" } },
      }),
    ).toEqual({
      user_id: "@alice:test",
      device_id: "DEVICE",
      algorithms: ["m.olm.v1.curve25519-aes-sha2"],
      keys: { "curve25519:DEVICE": "pub" },
      signatures: { "@alice:test": { "ed25519:DEVICE": "sig" } },
    });

    expect(
      parseDeviceKeysMap({
        DEVICE: { user_id: "@alice:test", device_id: "DEVICE" },
      }),
    ).toEqual({
      DEVICE: { user_id: "@alice:test", device_id: "DEVICE" },
    });

    expect(
      parseCrossSigningKeysStore({
        master: { user_id: "@alice:test", usage: ["master"] },
      }),
    ).toEqual({
      master: { user_id: "@alice:test", usage: ["master"] },
    });
  });

  it("parses signatures upload and uia session payloads", () => {
    expect(
      parseSignaturesUploadRequest({
        "@alice:test": {
          DEVICE: {
            device_id: "DEVICE",
            signatures: { "@bob:test": { "ed25519:BOB": "sig" } },
          },
        },
      }),
    ).toEqual({
      "@alice:test": {
        DEVICE: {
          device_id: "DEVICE",
          signatures: { "@bob:test": { "ed25519:BOB": "sig" } },
        },
      },
    });

    expect(parseTokenSubmitRequest({ session: "abc" })).toEqual({ session: "abc" });
    expect(parseTokenSubmitRequest({ session: 1 })).toBeNull();

    expect(
      parseUiaSessionData({
        user_id: "@alice:test",
        created_at: 1,
        type: "device_signing_upload",
        completed_stages: ["m.login.sso"],
      }),
    ).toEqual({
      user_id: "@alice:test",
      created_at: 1,
      type: "device_signing_upload",
      completed_stages: ["m.login.sso"],
    });

    expect(parseJsonObject({ key: "value" })).toEqual({ key: "value" });
    expect(parseJsonObject("bad")).toBeNull();
  });

  it("detects idempotent cross-signing uploads", () => {
    expect(
      isIdempotentCrossSigningUpload(
        {
          master: {
            user_id: "@alice:test",
            usage: ["master"],
            keys: { "ed25519:master": "pub" },
          },
        },
        {
          master_key: {
            keys: { "ed25519:master": "pub" },
            usage: ["master"],
            user_id: "@alice:test",
          },
        },
      ),
    ).toBe(true);

    expect(
      isIdempotentCrossSigningUpload(
        {
          master: {
            user_id: "@alice:test",
            usage: ["master"],
            keys: { "ed25519:master": "pub" },
          },
        },
        {
          self_signing_key: {
            user_id: "@alice:test",
            usage: ["self_signing"],
            keys: { "ed25519:self": "pub2" },
          },
        },
      ),
    ).toBe(false);
  });
});
