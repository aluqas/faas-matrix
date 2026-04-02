import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("federation transaction route boundary", () => {
  it("keeps transaction routing thin", () => {
    const source = readFileSync(new URL("./transaction.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bprepare\(/);
    expect(source).not.toMatch(/\brunFederationEffect\(/);
    expect(source).toMatch(/services\.federation\.processTransaction/);
  });
});
