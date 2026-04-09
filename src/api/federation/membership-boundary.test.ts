import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("federation membership route boundary", () => {
  it("keeps api/federation/membership.ts focused on decode and use-case calls", () => {
    const source = readFileSync(new URL("./membership.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bDB\.prepare\(/);
    expect(source).not.toMatch(/\bpersistFederationMembershipEvent\(/);
    expect(source).not.toMatch(/\bapplyMembershipTransitionToDatabase\(/);
    expect(source).not.toMatch(/\bgetServerSigningKey\(/);
    expect(source).toMatch(/buildFederationMakeJoinTemplate/);
    expect(source).toMatch(/processFederationSendJoin/);
    expect(source).toMatch(/buildFederationMakeLeaveTemplate/);
    expect(source).toMatch(/processFederationSendLeave/);
    expect(source).toMatch(/processFederationInvite/);
    expect(source).toMatch(/buildFederationMakeKnockTemplate/);
    expect(source).toMatch(/processFederationSendKnock/);
    expect(source).toMatch(/exchangeFederationThirdPartyInvite/);
  });
});
