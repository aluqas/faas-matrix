import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("federation e2ee route boundary", () => {
  it("keeps federation/e2ee.ts focused on decode and use-case calls", () => {
    const source = readFileSync(new URL("./e2ee.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bDB\.prepare\(/);
    expect(source).not.toMatch(/\bONE_TIME_KEYS\.(get|put)\(/);
    expect(source).not.toMatch(/\bJSON\.parse\(/);
    expect(source).toMatch(/encodeFederationKeysQueryResponse/);
    expect(source).toMatch(/encodeFederationKeysClaimResponse/);
    expect(source).toMatch(/decodeFederationKeysQueryInput/);
    expect(source).toMatch(/decodeFederationKeysClaimInput/);
    expect(source).toMatch(/queryFederationDeviceKeysEffect/);
    expect(source).toMatch(/claimFederationOneTimeKeysEffect/);
    expect(source).toMatch(/queryFederationUserDevicesEffect/);
  });
});
