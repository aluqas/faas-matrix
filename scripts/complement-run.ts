#!/usr/bin/env bun
/**
 * Run Complement tests against the faas-matrix homeserver image.
 *
 * Usage:
 *   bun run scripts/complement-run.ts [options] [TestName ...]
 *   bun run scripts/complement-run.ts "TestFoo/subcase_name"
 *   bun run scripts/complement-run.ts --list [PATTERN]
 *   bun run scripts/complement-run.ts --build-only
 *
 * Environment:
 *   COMPLEMENT_DIR  complement checkout path (default: .saqula/complement)
 *   IMAGE           docker image name (default: complement-faas-matrix)
 *   NO_BUILD        1 = skip build, 0 = force build (default: auto from source hash)
 *   DIRTY           1 = skip DB reset in container
 *   PARALLEL        go test -parallel N (default: 1)
 *   LOG             override log file path
 */

import { $ } from "bun";
import { createHash } from "crypto";
import fs from "fs";
import path from "path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const complementDir = process.env.COMPLEMENT_DIR ?? path.join(repoRoot, ".saqula/complement");
const image = process.env.IMAGE ?? "complement-faas-matrix";
const dirty = process.env.DIRTY ?? "0";
const parallel = process.env.PARALLEL ?? "1";
let noBuild = process.env.NO_BUILD; // undefined = auto-detect

const args = process.argv.slice(2);

// ---------------------------------------------------------------------------
// --list
// ---------------------------------------------------------------------------

if (args[0] === "--list") {
  const pattern = args[1] ?? ".*";
  console.log(`==> Listing tests matching: ${pattern}`);
  await $`COMPLEMENT_BASE_IMAGE=${image} go test ./tests/... -list ${pattern}`
    .cwd(complementDir)
    .nothrow();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// --build-only
// ---------------------------------------------------------------------------

if (args[0] === "--build-only") {
  await buildImage();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Test filter
// ---------------------------------------------------------------------------

let runFilter = "";
if (args.length === 1) {
  runFilter = args[0];
} else if (args.length > 1) {
  runFilter = args.join("|");
}

// ---------------------------------------------------------------------------
// Log path (datetime-based, written to logs/)
// ---------------------------------------------------------------------------

const logPath =
  process.env.LOG ??
  (() => {
    const dir = path.join(repoRoot, "logs");
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace("T", "_").replace(/:/g, "-").slice(0, 19);
    return path.join(dir, `${ts}.log`);
  })();

// ---------------------------------------------------------------------------
// Hash-based build skip
// ---------------------------------------------------------------------------

if (noBuild === undefined) {
  noBuild = "0";
  try {
    const raw = await $`git rev-parse HEAD:src HEAD:migrations HEAD:docker/complement`
      .cwd(repoRoot)
      .text();
    const hash = `${dirty}:${createHash("sha256").update(raw).digest("hex")}`;
    const cacheFile = path.join(repoRoot, ".saqula/.last-image-hash");
    const cached = fs.existsSync(cacheFile) ? fs.readFileSync(cacheFile, "utf8").trim() : "";
    if (hash === cached) {
      console.log("==> Source unchanged, skipping Docker build (set NO_BUILD=0 to force)");
      noBuild = "1";
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// Docker build
// ---------------------------------------------------------------------------

if (noBuild !== "1") {
  await buildImage();
}

// ---------------------------------------------------------------------------
// Run tests
// ---------------------------------------------------------------------------

console.log(
  `==> Running tests${runFilter ? ` (filter: ${runFilter})` : ""} (parallel=${parallel})...`,
);
console.log(`    Log: ${logPath}`);

const runArgs = ["-json", "-count=1", "-parallel", parallel];
if (runFilter) runArgs.push("-run", runFilter);

const logFd = fs.openSync(logPath, "w");
const proc = Bun.spawn(["go", "test", "./tests/...", ...runArgs], {
  cwd: complementDir,
  env: { ...process.env, COMPLEMENT_BASE_IMAGE: image },
  stdout: logFd,
  stderr: logFd,
});
await proc.exited;
fs.closeSync(logFd);

// ---------------------------------------------------------------------------
// Inline summary
// ---------------------------------------------------------------------------

await $`bun run ${path.join(repoRoot, "scripts/complement-summary.ts")} ${logPath}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function buildImage() {
  console.log(`==> Building Docker image ${image} (DIRTY=${dirty})...`);
  const dockerfile = path.join(repoRoot, "docker/complement/Dockerfile");
  await $`docker build --build-arg DIRTY_RUNS=${dirty} -f ${dockerfile} -t ${image} ${repoRoot}`;

  try {
    const raw = await $`git rev-parse HEAD:src HEAD:migrations HEAD:docker/complement`
      .cwd(repoRoot)
      .text();
    const hash = `${dirty}:${createHash("sha256").update(raw).digest("hex")}`;
    fs.writeFileSync(path.join(repoRoot, ".saqula/.last-image-hash"), hash);
  } catch {}

  console.log(`Image built: ${image}`);
}
