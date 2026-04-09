import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const currentDir = dirname(fileURLToPath(import.meta.url));

describe("federation transaction effect boundary", () => {
  it("keeps federation runtime execution out of transaction and PDU ingest features", () => {
    const guardedFiles = [
      join(currentDir, "transaction.ts"),
      join(currentDir, "pdu-ingest.ts"),
      join(currentDir, "edu-ingest.ts"),
    ];

    for (const filePath of guardedFiles) {
      const source = readFileSync(filePath, "utf8");
      expect(source, filePath).not.toContain("runFederationEffect");
      expect(source, filePath).not.toContain("Effect.runPromise");
    }
  });
});
