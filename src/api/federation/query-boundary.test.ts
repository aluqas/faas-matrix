import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import app from "./query";

describe("federation query route boundary", () => {
  it("keeps api/federation/query.ts focused on decode and use-case calls", () => {
    const source = readFileSync(new URL("./query.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bDB\.prepare\(/);
    expect(source).not.toMatch(/\btoUserId\(/);
    expect(source).not.toMatch(/\btoRoomId\(/);
    expect(source).not.toMatch(/\bparseFederationEventRelationshipsRequest\(/);
    expect(source).toMatch(/encodeFederationServerKeysResponse/);
    expect(source).toMatch(/encodeFederationProfileResponse/);
    expect(source).toMatch(/decodeFederationServerKeysBatchQueryInput/);
    expect(source).toMatch(/decodeFederationServerKeysQueryInput/);
    expect(source).toMatch(/decodeFederationDirectoryQueryInput/);
    expect(source).toMatch(/decodeFederationProfileQueryInput/);
    expect(source).toMatch(/decodeFederationEventRelationshipsInput/);
  });

  it("returns bad_json for invalid server key batch bodies", async () => {
    const response = await app.request("http://localhost/_matrix/key/v2/query", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: "{invalid",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      errcode: "M_BAD_JSON",
    });
  });

  it("returns missing_param for missing server_keys", async () => {
    const response = await app.request("http://localhost/_matrix/key/v2/query", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      errcode: "M_MISSING_PARAM",
    });
  });

  it("returns invalid_param for malformed federation profile queries", async () => {
    const invalidUserIdResponse = await app.request(
      "http://localhost/_matrix/federation/v1/query/profile?user_id=invalid",
    );

    expect(invalidUserIdResponse.status).toBe(400);
    await expect(invalidUserIdResponse.json()).resolves.toMatchObject({
      errcode: "M_INVALID_PARAM",
    });

    const invalidFieldResponse = await app.request(
      "http://localhost/_matrix/federation/v1/query/profile?user_id=%40alice%3Atest&field=nickname",
    );

    expect(invalidFieldResponse.status).toBe(400);
    await expect(invalidFieldResponse.json()).resolves.toMatchObject({
      errcode: "M_INVALID_PARAM",
    });
  });

  it("returns bad_json for malformed event relationships bodies", async () => {
    const response = await app.request(
      "http://localhost/_matrix/federation/unstable/event_relationships",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ event_id: "invalid" }),
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      errcode: "M_BAD_JSON",
    });
  });
});
