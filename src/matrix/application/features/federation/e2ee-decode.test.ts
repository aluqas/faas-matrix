import { describe, expect, it } from "vitest";
import { runFederationEffect } from "../../effect-runtime";
import {
  decodeFederationKeysClaimInput,
  decodeFederationKeysQueryInput,
  decodeFederationUserDevicesInput,
} from "./e2ee-decode";

describe("federation e2ee decode", () => {
  it("decodes keys query input", async () => {
    await expect(
      runFederationEffect(
        decodeFederationKeysQueryInput({
          device_keys: { "@alice:test": ["DEVICE"] },
        }),
      ),
    ).resolves.toEqual({
      requestedKeys: { "@alice:test": ["DEVICE"] },
    });
  });

  it("rejects malformed claim input", async () => {
    await expect(
      runFederationEffect(
        decodeFederationKeysClaimInput({
          one_time_keys: { "@alice:test": { DEVICE: 1 } },
        }),
      ),
    ).rejects.toMatchObject({
      errcode: "M_BAD_JSON",
    });
  });

  it("decodes user devices input", async () => {
    await expect(
      runFederationEffect(decodeFederationUserDevicesInput("@alice:test")),
    ).resolves.toEqual({
      userId: "@alice:test",
    });
  });
});
