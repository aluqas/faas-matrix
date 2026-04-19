import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("presence route boundary", () => {
  it("keeps api/presence.ts focused on decode and use-case calls", () => {
    const source = readFileSync(new URL("./presence.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bDB\.prepare\(/);
    expect(source).not.toMatch(/\bupsertPresence\(/);
    expect(source).not.toMatch(/\bwritePresenceToCache\(/);
    expect(source).not.toMatch(/\bqueueFederationEdu\(/);
    expect(source).toMatch(/decodeSetPresenceStatusInput/);
    expect(source).toMatch(/decodeGetPresenceStatusInput/);
    expect(source).toMatch(/setPresenceStatusEffect/);
    expect(source).toMatch(/getPresenceStatusEffect/);
  });

  it("keeps presence feature code free of client runtime execution", () => {
    const command = readFileSync(
      new URL("../features/presence/command.ts", import.meta.url),
      "utf8",
    );
    expect(command).not.toMatch(/\brunClientEffect\(/);
  });
});
