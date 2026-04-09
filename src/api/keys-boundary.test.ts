import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("keys route boundary", () => {
  it("keeps api/keys.ts focused on orchestration and encoder usage for the hot path", () => {
    const source = readFileSync(new URL("./keys.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bDB\.prepare\(/);
    expect(source).not.toMatch(/\bmarkStoredOneTimeKeyClaimed\(/);
    expect(source).not.toMatch(/\bclaimUnclaimedOneTimeKey\(/);
    expect(source).not.toMatch(/\bclaimFallbackKey\(/);
    expect(source).toMatch(/encodeClientKeysQueryResponse/);
    expect(source).toMatch(/encodeClientKeysClaimResponse/);
    expect(source).toMatch(/encodeClientKeysChangesResponse/);
    expect(source).toMatch(/claimOneTimeKeyFromStoreChain/);
  });
});
