import { describe, expect, it } from "vitest";
import {
  toFederationClaimedOneTimeKeyRecord,
  toFederationDeviceSignatureRecord,
  toFederationStoredDeviceRecord,
} from "./e2ee-repository";

describe("e2ee repository row parsers", () => {
  it("normalizes signature and device rows", () => {
    expect(
      toFederationDeviceSignatureRecord({
        signer_user_id: "@alice:test",
        signer_key_id: "ed25519:DEVICE",
        signature: "sig",
      }),
    ).toEqual({
      signerUserId: "@alice:test",
      signerKeyId: "ed25519:DEVICE",
      signature: "sig",
    });

    expect(
      toFederationStoredDeviceRecord({
        device_id: "DEVICE",
        display_name: "Alice phone",
      }),
    ).toEqual({
      deviceId: "DEVICE",
      displayName: "Alice phone",
    });
  });

  it("rejects invalid persisted key payloads", () => {
    expect(() =>
      toFederationClaimedOneTimeKeyRecord({
        key_id: "signed_curve25519:AAA",
        key_data: '"invalid"',
      }),
    ).toThrow("Stored E2EE JSON payload is not a valid object");
  });
});
