import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("federation keys service boundary", () => {
  it("keeps services/federation-keys.ts focused on federation transport and cache policy", () => {
    const source = readFileSync(new URL("./federation-keys.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bDB\.prepare\(/);
    expect(source).toMatch(/getCurrentServerSigningKeyRecord/);
    expect(source).toMatch(/replaceCurrentServerSigningKey/);
    expect(source).toMatch(/listNonExpiredRemoteServerKeys/);
    expect(source).toMatch(/upsertRemoteServerKeys/);
  });
});
