import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const currentDir = dirname(fileURLToPath(import.meta.url));

describe("federation e2ee repository boundary", () => {
  it("uses the neutral e2ee repository from feature code", () => {
    const guardedFiles = [
      join(currentDir, "e2ee-effect-adapters.ts"),
      join(currentDir, "e2ee-claim-store.ts"),
    ];

    for (const filePath of guardedFiles) {
      const source = readFileSync(filePath, "utf8");
      expect(source, filePath).toContain("../../infra/repositories/e2ee-repository");
      expect(source, filePath).not.toContain("../../infra/repositories/federation-e2ee-repository");
    }
  });
});
