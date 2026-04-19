import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("repository SQL boundaries", () => {
  it("keeps membership repository on Kysely execution helpers", () => {
    const source = readFileSync(new URL("./membership-repository.ts", import.meta.url), "utf8");

    expect(source).not.toMatch(/\bDB\.prepare\(/);
    expect(source).not.toMatch(/\bdb\.prepare\(/);
    expect(source).toMatch(/\bexecuteKyselyQuery(?:<|\()/);
    expect(source).toMatch(/\bexecuteKyselyQueryFirst(?:<|\()/);
  });
});
