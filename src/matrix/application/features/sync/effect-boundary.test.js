import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const currentDir = dirname(fileURLToPath(import.meta.url));

function listImplementationFiles(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listImplementationFiles(entryPath));
      continue;
    }

    if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(entryPath);
    }
  }

  return files;
}

describe("sync effect boundary", () => {
  it("keeps effect execution at the entrypoints", () => {
    const guardedFiles = [
      ...listImplementationFiles(currentDir),
      join(currentDir, "..", "presence", "project.ts"),
      join(currentDir, "..", "typing", "project.ts"),
    ];

    for (const filePath of guardedFiles) {
      const source = readFileSync(filePath, "utf8");
      expect(source, filePath).not.toContain("runClientEffect");
      expect(source, filePath).not.toContain("runFederationEffect");
      expect(source, filePath).not.toContain("Effect.runPromise");
    }
  });
});
