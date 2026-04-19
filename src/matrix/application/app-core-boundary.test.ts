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
    expect(source).not.toMatch(/infra\/db\/database/);
    expect(source).toMatch(/\bloadFederationStateBundleFromRepository\(/);
    expect(source).toMatch(/\bfederationEventExists\(/);
    expect(source).toMatch(/\bingestReceiptEduEffect\(/);
    expect(source).toMatch(/\bingestTypingEduEffect\(/);
  });

  it("keeps relationship-service free of direct database helper imports", () => {
    const source = readFileSync(new URL("./relationship-service.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/infra\/db\/database/);
    expect(source).toMatch(/\bgetAuthChainForRelations\(/);
  });

  it("keeps target app-core repositories free of database helper imports", () => {
    const repositories = [
      "../../infra/repositories/membership-transition-repository.ts",
      "../../infra/repositories/federation-state-repository.ts",
      "../../infra/repositories/relations-repository.ts",
      "../../infra/repositories/event-query-repository.ts",
    ];

    for (const repository of repositories) {
      const source = readFileSync(new URL(repository, import.meta.url), "utf8");
      expect(source).not.toMatch(/infra\/db\/database/);
    }
  });
});
