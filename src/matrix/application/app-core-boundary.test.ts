import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("app-core repository boundaries", () => {
  it("keeps membership-transition-service free of direct DB.prepare calls", () => {
    const source = readFileSync(
      new URL("./membership-transition-service.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/\bprepare\(/);
    expect(source).toMatch(/\bpersistMembershipTransitionResult\(/);
    expect(source).toMatch(/\bloadMembershipTransitionContextFromRepository\(/);
  });

  it("keeps event-query-service as a thin wrapper over the repository", () => {
    const source = readFileSync(
      new URL("./orchestrators/event-query-service.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/\bprepare\(/);
    expect(source).toMatch(/\bnew EventQueryRepository\(/);
  });

  it("keeps federation-handler-service free of direct DB.prepare calls", () => {
    const source = readFileSync(
      new URL("./orchestrators/federation-handler-service.ts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(/\bprepare\(/);
    expect(source).toMatch(/\bloadFederationStateBundleFromRepository\(/);
    expect(source).toMatch(/\bfederationEventExists\(/);
    expect(source).toMatch(/\bgetEffectiveMembershipForRealtimeUser\(/);
  });
});
