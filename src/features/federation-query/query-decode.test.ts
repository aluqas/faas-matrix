import { describe, expect, it } from "vitest";
import { runFederationEffect } from "../../matrix/application/runtime/effect-runtime";
import {
  decodeFederationDirectoryQueryInput,
  decodeFederationEventRelationshipsInput,
  decodeFederationProfileQueryInput,
  decodeFederationServerKeysBatchQueryInput,
  decodeFederationServerKeysQueryInput,
} from "./query-decode";

describe("federation query decode", () => {
  it("rejects missing server_keys in batch requests", async () => {
    await expect(
      runFederationEffect(decodeFederationServerKeysBatchQueryInput({})),
    ).rejects.toMatchObject({
      errcode: "M_MISSING_PARAM",
      status: 400,
    });
  });

  it("decodes server key query path/query inputs", async () => {
    await expect(
      runFederationEffect(
        decodeFederationServerKeysQueryInput({
          serverName: "remote.example",
          keyId: "ed25519:remote",
          minimumValidUntilTs: "5",
        }),
      ),
    ).resolves.toEqual({
      serverName: "remote.example",
      keyId: "ed25519:remote",
      minimumValidUntilTs: 5,
    });
  });

  it("rejects invalid federation profile parameters", async () => {
    await expect(
      runFederationEffect(
        decodeFederationProfileQueryInput({
          userId: "not-a-user-id",
        }),
      ),
    ).rejects.toMatchObject({
      errcode: "M_INVALID_PARAM",
      status: 400,
    });

    await expect(
      runFederationEffect(
        decodeFederationProfileQueryInput({
          userId: "@alice:test",
          field: "nickname",
        }),
      ),
    ).rejects.toMatchObject({
      errcode: "M_INVALID_PARAM",
      status: 400,
    });
  });

  it("rejects missing directory aliases", async () => {
    await expect(
      runFederationEffect(decodeFederationDirectoryQueryInput({ roomAlias: undefined })),
    ).rejects.toMatchObject({
      errcode: "M_MISSING_PARAM",
      status: 400,
    });
  });

  it("rejects malformed event relationship payloads", async () => {
    await expect(
      runFederationEffect(decodeFederationEventRelationshipsInput({ event_id: "invalid" })),
    ).rejects.toMatchObject({
      errcode: "M_BAD_JSON",
      status: 400,
    });

    await expect(
      runFederationEffect(
        decodeFederationEventRelationshipsInput({
          event_id: "$event",
          max_depth: "deep",
        }),
      ),
    ).rejects.toMatchObject({
      errcode: "M_INVALID_PARAM",
      status: 400,
    });
  });
});
