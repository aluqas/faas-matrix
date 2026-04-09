import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("profile route boundary", () => {
  it("keeps api/profile.ts focused on decode and use-case calls", () => {
    const source = readFileSync(new URL("./profile.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bupdateUserProfile\(/);
    expect(source).not.toMatch(/\bgetUserById\(/);
    expect(source).not.toMatch(/\bCACHE\.get\(/);
    expect(source).not.toMatch(/\bCACHE\.put\(/);
    expect(source).not.toMatch(/\bJSON\.parse\(/);
    expect(source).not.toMatch(/\btoFieldResponse\(/);
    expect(source).toMatch(/decodeProfileFieldUpdateInput/);
    expect(source).toMatch(/encodeProfileFieldResponse/);
    expect(source).toMatch(/queryProfileEffect/);
    expect(source).toMatch(/putCustomProfileKeyEffect/);
  });
});
