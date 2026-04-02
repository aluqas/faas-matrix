import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const currentDir = dirname(fileURLToPath(import.meta.url));

describe("federation query effect boundary", () => {
  it("keeps effect execution at the federation route entrypoints", () => {
    const guardedFiles = [join(currentDir, "query.ts")];

    for (const filePath of guardedFiles) {
      const source = readFileSync(filePath, "utf8");
      expect(source, filePath).not.toContain("runClientEffect");
      expect(source, filePath).not.toContain("runFederationEffect");
      expect(source, filePath).not.toContain("Effect.runPromise");
    }
  });
});
