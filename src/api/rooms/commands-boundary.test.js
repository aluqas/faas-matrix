import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("rooms commands route boundary", () => {
  it("keeps write command routing thin", () => {
    const source = readFileSync(new URL("./commands.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bfanoutEventToRemoteServers\b/);
    expect(source).not.toMatch(/\bgetMembership\b/);
    expect(source).not.toMatch(/\bnotifyUsersOfEvent\b/);
    expect(source).toMatch(/services\.rooms\.sendEvent/);
    expect(source).toMatch(/services\.rooms\.inviteRoom/);
    expect(source).toMatch(/services\.rooms\.kickUser/);
    expect(source).toMatch(/services\.rooms\.banUser/);
    expect(source).toMatch(/services\.rooms\.unbanUser/);
  });
});
