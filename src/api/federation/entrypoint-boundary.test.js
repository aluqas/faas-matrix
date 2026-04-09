import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("federation entrypoint boundary", () => {
  it("keeps split routes out of api/federation.ts", () => {
    const source = readFileSync(new URL("../federation.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bDB\.prepare\(/);
    expect(source).toMatch(/federationQueryRoutes/);
    expect(source).toMatch(/federationEventsRoutes/);
    expect(source).toMatch(/federationMembershipRoutes/);
    expect(source).toMatch(/federationE2eeRoutes/);
    expect(source).not.toMatch(/_matrix\/key\/v2\/query/);
    expect(source).not.toMatch(/_matrix\/federation\/v1\/query\/directory/);
    expect(source).not.toMatch(/_matrix\/federation\/v1\/query\/profile/);
    expect(source).not.toMatch(/_matrix\/federation\/unstable\/event_relationships/);
    expect(source).not.toMatch(/_matrix\/federation\/v1\/get_missing_events/);
    expect(source).not.toMatch(/_matrix\/federation\/v1\/event\/:eventId/);
    expect(source).not.toMatch(/_matrix\/federation\/v1\/state\/:roomId/);
    expect(source).not.toMatch(/_matrix\/federation\/v1\/make_join/);
    expect(source).not.toMatch(/_matrix\/federation\/v1\/send_knock/);
    expect(source).not.toMatch(/_matrix\/federation\/v1\/user\/keys\/query/);
    expect(source).not.toMatch(/_matrix\/federation\/v1\/user\/devices/);
  });
});
