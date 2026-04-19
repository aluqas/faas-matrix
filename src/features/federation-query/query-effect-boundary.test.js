import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const currentDir = dirname(fileURLToPath(import.meta.url));

describe("federation query effect boundary", () => {
  it("keeps effect execution at the federation route entrypoints", () => {
    const guardedFiles = [
      join(currentDir, "query.ts"),
      join(currentDir, "profile-query-effect.ts"),
      join(currentDir, "server-keys-query-effect.ts"),
      join(currentDir, "directory-query-effect.ts"),
      join(currentDir, "relationships-query-effect.ts"),
      join(currentDir, "query-shared.ts"),
    ];

    for (const filePath of guardedFiles) {
      const source = readFileSync(filePath, "utf8");
      expect(source, filePath).not.toContain("runClientEffect");
      expect(source, filePath).not.toContain("runFederationEffect");
      expect(source, filePath).not.toContain("Effect.runPromise");
    }
  });

  it("keeps relationships wiring on the effect-native app-core port", () => {
    const source = readFileSync(join(currentDir, "query-shared.ts"), "utf8");

    expect(source).toContain("createRelationshipServicePorts");
    expect(source).toContain("buildFederatedEventRelationshipsResponseEffect");
    expect(source).not.toMatch(/\bbuildFederatedEventRelationshipsResponse\(/);
  });
});
