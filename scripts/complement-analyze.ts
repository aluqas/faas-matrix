#!/usr/bin/env bun
/**
 * Analyze Complement test logs in logs/ and print delta/summary.
 *
 * Logs are named YYYY-MM-DD_HH-MM-SS.log (newest first).
 *
 * Usage:
 *   bun run scripts/complement-analyze.ts [options]
 *
 * Options:
 *   --depth N     include subtests up to depth N (default: 0)
 *   --failing     show failing test list in detail
 *   --last N      analyze only the N most recent logs (default: all)
 */

import path from "path";
import { loadLogs, summarize, delta, byCat, pct } from "./complement-log.ts";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let depth = 0;
let failingOnly = false;
let lastN = Infinity;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--depth" && args[i + 1] !== undefined) depth = parseInt(args[++i]);
  else if (args[i] === "--failing") failingOnly = true;
  else if (args[i] === "--last" && args[i + 1] !== undefined) lastN = parseInt(args[++i]);
}

// ---------------------------------------------------------------------------
// Load logs
// ---------------------------------------------------------------------------

const repoRoot = path.resolve(import.meta.dirname, "..");
const logsDir = path.join(repoRoot, "logs");

const parsed = loadLogs(logsDir, depth, lastN);

if (parsed.length === 0) {
  console.error(`No logs found in ${logsDir}`);
  console.error("Run: bun run complement:run");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Summary table
// ---------------------------------------------------------------------------

console.log(`\n=== Summary (depth=${depth}${failingOnly ? ", failing-only" : ""}) ===`);
for (const { name, mtime, results } of parsed) {
  const s = summarize(results);
  const passStr = failingOnly ? "" : `Pass ${s.pass} (${pct(s.pass, s.total)}%)  `;
  console.log(`${name} [${mtime}]: Total ${s.total}  ${passStr}Fail ${s.fail}  Skip ${s.skip}`);
}

// ---------------------------------------------------------------------------
// Deltas: consecutive runs (parsed[0] = newest)
// ---------------------------------------------------------------------------

for (let i = parsed.length - 1; i >= 1; i--) {
  const d = delta(parsed[i].results, parsed[i - 1].results);
  console.log(`\n=== ${parsed[i].name} → ${parsed[i - 1].name} ===`);
  console.log(`Newly PASSING (${d.newPasses.length}):`);
  for (const t of d.newPasses) console.log(`  + ${t}`);
  console.log(`Newly FAILING (${d.newFails.length}):`);
  for (const t of d.newFails) console.log(`  - ${t}`);
  if (d.appeared.length) {
    console.log(`New passes not in before (${d.appeared.length}):`);
    for (const t of d.appeared) console.log(`  * ${t}`);
  }
}

if (parsed.length > 2) {
  const d = delta(parsed[parsed.length - 1].results, parsed[0].results);
  console.log(`\n=== ${parsed[parsed.length - 1].name} → ${parsed[0].name} (overall) ===`);
  console.log(`Newly PASSING (${d.newPasses.length}):`);
  for (const t of d.newPasses) console.log(`  + ${t}`);
  console.log(`Newly FAILING (${d.newFails.length}):`);
  for (const t of d.newFails) console.log(`  - ${t}`);
}

// ---------------------------------------------------------------------------
// Failures in latest by category
// ---------------------------------------------------------------------------

const latestFails = summarize(parsed[0].results).fails;

console.log(`\n=== Failures in ${parsed[0].name} by category ===`);
if (latestFails.length === 0) {
  console.log("  (none)");
} else {
  for (const [cat, count] of byCat(latestFails)) {
    console.log(`  ${count.toString().padStart(3)}  ${cat}`);
  }
}

if (failingOnly) {
  console.log(`\n=== Failing tests in ${parsed[0].name} ===`);
  for (const t of [...latestFails].sort()) console.log(`  ✗ ${t}`);
}
