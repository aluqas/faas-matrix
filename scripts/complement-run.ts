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
 *   DOCKER_LOGS     1 = capture running complement container logs (default: 1)
 */

import { $ } from "bun";
import { createHash } from "crypto";
import fs from "fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import path from "path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const complementDir = process.env.COMPLEMENT_DIR ?? path.join(repoRoot, ".saqula/complement");
const image = process.env.IMAGE ?? "complement-faas-matrix";
const dirty = process.env.DIRTY ?? "0";
const parallel = process.env.PARALLEL ?? "1";
const dockerLogsEnabled = (process.env.DOCKER_LOGS ?? "1") !== "0";
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
const dockerLogPath = logPath.endsWith(".log")
  ? logPath.replace(/\.log$/, ".docker.log")
  : `${logPath}.docker.log`;

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
if (dockerLogsEnabled) {
  console.log(`    Docker log: ${dockerLogPath}`);
}

const runArgs = ["-json", "-count=1", "-parallel", parallel];
if (runFilter) runArgs.push("-run", runFilter);

const dockerCapture = dockerLogsEnabled ? startDockerLogCapture(dockerLogPath, image) : null;
const logFd = fs.openSync(logPath, "w");
const proc = Bun.spawn(["go", "test", "./tests/...", ...runArgs], {
  cwd: complementDir,
  env: { ...process.env, COMPLEMENT_BASE_IMAGE: image },
  stdout: logFd,
  stderr: logFd,
});
await proc.exited;
if (dockerCapture) {
  await dockerCapture.stop();
}
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

type DockerLogCapture = {
  stop: () => Promise<void>;
};

function startDockerLogCapture(sidecarLogPath: string, targetImage: string): DockerLogCapture {
  fs.writeFileSync(sidecarLogPath, "");
  const logFd = fs.openSync(sidecarLogPath, "a");
  const followers = new Map<string, { proc: ChildProcessWithoutNullStreams; done: Promise<void> }>();
  let stopped = false;
  let scanPromise: Promise<void> | null = null;

  const appendLine = (line: string) => {
    fs.writeSync(logFd, `${line}\n`);
  };

  const pipeStream = async (
    stream: NodeJS.ReadableStream,
    prefix: string,
    onClose?: () => void,
  ): Promise<void> => {
    const rl = createInterface({ input: stream });
    await new Promise<void>((resolve) => {
      rl.on("line", (line) => appendLine(`${prefix}${line}`));
      rl.once("close", () => {
        onClose?.();
        resolve();
      });
      stream.once("error", () => {
        rl.close();
        resolve();
      });
    });
  };

  const shouldCapture = (imageName: string, name: string) =>
    imageName === targetImage || imageName.includes("complement") || name.includes("complement_");

  const followContainer = (containerId: string, imageName: string, name: string) => {
    if (stopped || followers.has(containerId)) {
      return;
    }

    appendLine(`===== container ${name} (${containerId}) image=${imageName} =====`);
    const proc = spawn("docker", ["logs", "-f", "--timestamps", containerId], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const done = Promise.all([
      pipeStream(proc.stdout, `[docker:${name}] `),
      pipeStream(proc.stderr, `[docker:${name}:stderr] `),
      new Promise<void>((resolve) => {
        proc.once("close", (code, signal) => {
          appendLine(
            `===== container ${name} (${containerId}) closed code=${code ?? "null"} signal=${signal ?? "null"} =====`,
          );
          resolve();
        });
      }),
    ]).then(() => undefined);

    followers.set(containerId, { proc, done });
    void done.finally(() => {
      followers.delete(containerId);
    });
  };

  const scanRunningContainers = async () => {
    const proc = spawn("docker", ["ps", "--format", "{{.ID}}\t{{.Image}}\t{{.Names}}"], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const exitCode = await new Promise<number>((resolve) => {
      proc.once("close", (code) => resolve(code ?? 0));
    });

    if (exitCode !== 0) {
      appendLine(`===== docker ps failed code=${exitCode} stderr=${stderr.trim()} =====`);
      return;
    }

    for (const line of stdout.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      const [containerId, imageName, name] = line.split("\t");
      if (!containerId || !imageName || !name || !shouldCapture(imageName, name)) {
        continue;
      }
      followContainer(containerId, imageName, name);
    }
  };

  const scheduleScan = () => {
    if (stopped || scanPromise) {
      return;
    }
    scanPromise = scanRunningContainers().finally(() => {
      scanPromise = null;
    });
  };

  scheduleScan();
  const interval = setInterval(scheduleScan, 500);

  return {
    stop: async () => {
      stopped = true;
      clearInterval(interval);
      if (scanPromise) {
        await scanPromise.catch(() => undefined);
      }
      const completions = Array.from(followers.values()).map(({ proc, done }) => {
        proc.kill("SIGTERM");
        return done.catch(() => undefined);
      });
      await Promise.all(completions);
      fs.closeSync(logFd);
    },
  };
}
