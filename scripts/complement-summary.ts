#!/usr/bin/env bun
/**
 * Print a pass/fail summary for a single Complement log file.
 * Called by complement-run.sh after each test run.
 *
 * Usage: bun run scripts/complement-summary.ts <logfile>
 */

import fs from "fs";
import { parseLog, summarize } from "./complement-log.ts";

const logPath = process.argv[2];
if (!logPath) {
  console.error("Usage: complement-summary.ts <logfile>");
  process.exit(1);
}

const content = fs.readFileSync(logPath, "utf8");
const results = parseLog(content, 0);

const topResults = Object.fromEntries(
  Object.entries(results).filter(([t]) => !t.includes("/")),
);
const { pass, fail, fails } = summarize(topResults);

console.log();
console.log("=".repeat(60));
console.log(`  PASS: ${pass}  FAIL: ${fail}`);
console.log("=".repeat(60));

if (fails.length > 0) {
  console.log("\nFAILED:");
  for (const t of [...fails].sort()) console.log(`  ✗ ${t}`);
}

const passes = Object.keys(topResults).filter((t) => topResults[t] === "pass");
if (passes.length > 0) {
  console.log("\nPASSED:");
  for (const t of [...passes].sort()) console.log(`  ✓ ${t}`);
}
