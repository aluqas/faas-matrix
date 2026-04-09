import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("federation events route boundary", () => {
  it("keeps api/federation/events.ts focused on route input and feature calls", () => {
    const source = readFileSync(new URL("./events.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bDB\.prepare\(/);
    expect(source).toMatch(/fetchFederationEventById/);
    expect(source).toMatch(/fetchFederationState/);
    expect(source).toMatch(/fetchFederationStateIds/);
    expect(source).toMatch(/fetchFederationEventAuth/);
    expect(source).toMatch(/fetchFederationBackfill/);
    expect(source).toMatch(/fetchFederationMissingEvents/);
  });
});
