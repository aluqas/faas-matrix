#!/usr/bin/env bun
/**
 * Set up the Complement test harness for faas-matrix.
 *
 * Usage: bun run scripts/complement-setup.ts
 *
 * Environment:
 *   COMPLEMENT_DIR  target directory (default: .saqula/complement)
 *   COMPLEMENT_REF  git ref to check out (default: pinned commit)
 */

import { $ } from "bun";
import fs from "fs";
import path from "path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const complementDir = process.env.COMPLEMENT_DIR ?? path.join(repoRoot, ".saqula/complement");

// Pinned to the commit used during development; update when upgrading complement.
const COMPLEMENT_REMOTE = "https://github.com/matrix-org/complement";
const COMPLEMENT_REF = process.env.COMPLEMENT_REF ?? "3adcab373fa98cad2b0a6979a8f11a679a6f3447";

// ---------------------------------------------------------------------------
// Prerequisites
// ---------------------------------------------------------------------------

console.log("==> Checking prerequisites...");

const docker = await $`docker --version`.nothrow().text();
if (!docker.trim()) {
  console.error("ERROR: docker not found. Install Docker Desktop or Docker Engine.");
  process.exit(1);
}
console.log(`  docker: ${docker.trim()}`);

const go = await $`go version`.nothrow().text();
if (!go.trim()) {
  console.error("ERROR: go not found. Install Go 1.24+ from https://go.dev/dl/");
  process.exit(1);
}
console.log(`  go: ${go.trim()}`);

// ---------------------------------------------------------------------------
// Complement clone
// ---------------------------------------------------------------------------

console.log();

if (fs.existsSync(path.join(complementDir, ".git"))) {
  const current = (await $`git rev-parse HEAD`.cwd(complementDir).text()).trim();
  console.log(`==> Complement already present at ${complementDir}`);
  console.log(`    HEAD: ${current}`);
  if (current !== COMPLEMENT_REF) {
    console.log(`    NOTE: differs from pinned ref ${COMPLEMENT_REF}`);
    console.log(
      `    To update: cd ${complementDir} && git fetch && git checkout ${COMPLEMENT_REF}`,
    );
  }
} else {
  console.log(`==> Cloning Complement into ${complementDir}...`);
  await $`git clone ${COMPLEMENT_REMOTE} ${complementDir}`;
  await $`git checkout ${COMPLEMENT_REF}`.cwd(complementDir);
  console.log(`    Checked out: ${COMPLEMENT_REF}`);
}

// ---------------------------------------------------------------------------
// Pre-fetch Go module dependencies
// ---------------------------------------------------------------------------

console.log();
console.log("==> Pre-fetching Go module dependencies...");
await $`go mod download`.cwd(complementDir);
console.log("    Done.");

// ---------------------------------------------------------------------------
// matrix-spec hint
// ---------------------------------------------------------------------------

if (!fs.existsSync(path.join(repoRoot, ".saqula/matrix-spec"))) {
  console.log();
  console.log("NOTE: .saqula/matrix-spec not found.");
  console.log("  Run the following to enable spec coverage checks:");
  console.log("    git clone https://github.com/matrix-org/matrix-spec .saqula/matrix-spec");
  console.log("    bun run spec:extract");
}

// ---------------------------------------------------------------------------

console.log();
console.log("==> Setup complete. You can now run:");
console.log("    bun run complement:full          # build image + run all tests + analyze");
console.log("    bun run complement:run:fast      # skip build, run all tests");
console.log("    bun run complement:index         # regenerate the test-name package index");
console.log("    bun run complement:run -- --list # list all test names");
console.log("    bun run complement:run -- TestLogin             # auto-resolve package");
console.log("    bun run complement:run:debug -- TestContentMediaV1");
