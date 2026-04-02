import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("rooms entrypoint boundary", () => {
  it("keeps api/rooms.ts mount-only", () => {
    const source = readFileSync(new URL("../rooms.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bprepare\(/);
    expect(source).not.toMatch(/\bservices\.rooms\./);
    expect(source).not.toMatch(/\bgetMembership\b/);
    expect(source).not.toMatch(/\bfederationGet\b/);
    expect(source).toMatch(/roomLifecycleRoutes/);
    expect(source).toMatch(/roomCommandRoutes/);
    expect(source).toMatch(/roomMembershipRoutes/);
    expect(source).toMatch(/roomQueryRoutes/);
    expect(source).toMatch(/roomStateRoutes/);
    expect(source).toMatch(/roomContextRoutes/);
    expect(source).toMatch(/roomDirectoryRoutes/);
  });
});
