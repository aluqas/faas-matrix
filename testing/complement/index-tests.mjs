#!/usr/bin/env bun

import fs from "fs";
import path from "path";
import { buildComplementTestIndex } from "./harness.ts";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const testsRoot = path.join(repoRoot, ".saqula/complement/tests");
const outputPath = path.join(repoRoot, "testing/complement/test-index.json");

if (!fs.existsSync(testsRoot)) {
  console.error(`Complement tests not found: ${testsRoot}`);
  console.error("Run `bun run complement:setup` first.");
  process.exit(1);
}

const index = buildComplementTestIndex(testsRoot);
fs.writeFileSync(outputPath, `${JSON.stringify(index, null, 2)}\n`);

console.log(`Wrote ${Object.keys(index).length} Complement test entries to ${outputPath}`);
