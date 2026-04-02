#!/usr/bin/env bun
/**
 * Run Complement tests against the faas-matrix homeserver image.
 *
 * Usage:
 *   bun run scripts/complement-run.ts [options] [TestName ...]
 *   bun run scripts/complement-run.ts --pkg ./tests/csapi TestAddAccountData
 *   bun run scripts/complement-run.ts --full
 *   bun run scripts/complement-run.ts --list-packages TestAddAccountData
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
import path from "path";
import { createInterface } from "node:readline";
import {
  buildRunSummaryArtifact,
  classifyComplementRun,
  loadComplementTestIndex,
  printRunSummary,
  resolveComplementPackages,
  topLevelTestName,
  writeJsonArtifact,
  type ComplementTestIndex,
} from "./complement-harness.ts";

interface CliOptions {
  listPattern: string | null;
  buildOnly: boolean;
  explicitPackages: string[];
  full: boolean;
  startupDebug: boolean;
  spawnTimeoutSeconds: number | null;
  listPackages: string | null;
  tests: string[];
}

type DockerLogCapture = {
  stop: () => Promise<void>;
};

const repoRoot = path.resolve(import.meta.dirname, "..");
const complementDir = process.env.COMPLEMENT_DIR ?? path.join(repoRoot, ".saqula/complement");
const image = process.env.IMAGE ?? "complement-faas-matrix";
const dirty = process.env.DIRTY ?? "0";
const parallel = process.env.PARALLEL ?? "1";
let noBuild = process.env.NO_BUILD; // undefined = auto-detect

const indexPath = path.join(repoRoot, "scripts", "complement-test-index.json");
const args = process.argv.slice(2);
const options = parseArgs(args);

if (options.listPattern !== null) {
  await listTests(options.listPattern);
  process.exit(0);
}

if (options.listPackages !== null) {
  const index = loadIndex(indexPath);
  const packages = index[topLevelTestName(options.listPackages)] ?? [];
  if (packages.length === 0) {
    console.error(`No package mapping found for ${options.listPackages}.`);
    console.error("Regenerate the index with: bun run complement:index");
    process.exit(1);
  }
  console.log(packages.join("\n"));
  process.exit(0);
}

if (options.buildOnly) {
  await buildImage();
  process.exit(0);
}

const packageResolution = resolvePackages(indexPath, options);
const packagesToRun = packageResolution.packages;
const runFilter = buildRunFilter(options.tests);
const fullRun = options.full || (options.explicitPackages.length === 0 && options.tests.length === 0);
const spawnTimeoutSeconds =
  options.spawnTimeoutSeconds ?? (options.startupDebug ? 60 : fullRun ? null : 40);

const logPath =
  process.env.LOG ??
  (() => {
    const dir = path.join(repoRoot, "logs");
    fs.mkdirSync(dir, { recursive: true });
    const baseTs = new Date().toISOString().replace("T", "_").replace(/:/g, "-").slice(0, 19);
    const pidSuffix = process.pid;
    let candidate = path.join(dir, `${baseTs}-${pidSuffix}.log`);
    let suffix = 1;
    while (fs.existsSync(candidate)) {
      candidate = path.join(dir, `${baseTs}-${pidSuffix}-${suffix}.log`);
      suffix += 1;
    }
    return candidate;
  })();
const dockerLogPath = logPath.endsWith(".log")
  ? logPath.replace(/\.log$/, ".docker.log")
  : `${logPath}.docker.log`;
const summaryPath = logPath.endsWith(".log")
  ? logPath.replace(/\.log$/, ".summary.json")
  : `${logPath}.summary.json`;
const classifiedPath = logPath.endsWith(".log")
  ? logPath.replace(/\.log$/, ".classified.json")
  : `${logPath}.classified.json`;

const dockerLogsEnabled = options.startupDebug || (process.env.DOCKER_LOGS ?? "1") !== "0";

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

if (noBuild !== "1") {
  await buildImage();
}

console.log(
  `==> Running Complement${runFilter ? ` (filter: ${runFilter})` : ""} on ${packagesToRun.join(", ")} (parallel=${parallel})...`,
);
console.log(`    Log: ${logPath}`);
console.log(`    Summary: ${summaryPath}`);
console.log(`    Classification: ${classifiedPath}`);
if (dockerLogsEnabled) {
  console.log(`    Docker log: ${dockerLogPath}`);
}
if (options.startupDebug) {
  console.log(
    `    Startup debug: enabled${spawnTimeoutSeconds ? ` (spawn timeout ${spawnTimeoutSeconds}s)` : ""}`,
  );
}

const runEnv = createComplementEnvironment({
  image,
  startupDebug: options.startupDebug,
  spawnTimeoutSeconds,
});
const runArgs = ["test", ...packagesToRun, "-json", "-count=1", "-parallel", parallel];
if (runFilter) {
  runArgs.push("-run", runFilter);
}

const dockerCapture = dockerLogsEnabled ? startDockerLogCapture(dockerLogPath, image) : null;
const logFd = fs.openSync(logPath, "w");
const proc = Bun.spawn(["go", ...runArgs], {
  cwd: complementDir,
  env: runEnv,
  stdout: logFd,
  stderr: logFd,
});
const exitCode = await proc.exited;
if (dockerCapture) {
  await dockerCapture.stop();
}
fs.closeSync(logFd);

const logContent = fs.readFileSync(logPath, "utf8");
const dockerLogContent = dockerLogsEnabled && fs.existsSync(dockerLogPath)
  ? fs.readFileSync(dockerLogPath, "utf8")
  : null;
const classified = classifyComplementRun(logContent, dockerLogContent);
const summary = buildRunSummaryArtifact({
  logContent,
  dockerLogContent,
  packages: packagesToRun,
  filter: runFilter || null,
  requestedTests: options.tests,
  fullRun,
  startupDebug: options.startupDebug,
  spawnTimeoutSeconds,
});

writeJsonArtifact(classifiedPath, classified);
writeJsonArtifact(summaryPath, summary);
printRunSummary(summary);

process.exit(exitCode);

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    listPattern: null,
    buildOnly: false,
    explicitPackages: [],
    full: false,
    startupDebug: false,
    spawnTimeoutSeconds: null,
    listPackages: null,
    tests: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--list") {
      options.listPattern = argv[i + 1] ?? ".*";
      if (argv[i + 1] !== undefined) {
        i += 1;
      }
      continue;
    }
    if (arg === "--build-only") {
      options.buildOnly = true;
      continue;
    }
    if (arg === "--pkg") {
      const packageName = argv[i + 1];
      if (!packageName) {
        fail(`Missing value for ${arg}`);
      }
      options.explicitPackages.push(packageName);
      i += 1;
      continue;
    }
    if (arg === "--full") {
      options.full = true;
      continue;
    }
    if (arg === "--startup-debug") {
      options.startupDebug = true;
      continue;
    }
    if (arg === "--spawn-timeout") {
      const value = argv[i + 1];
      if (!value) {
        fail(`Missing value for ${arg}`);
      }
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        fail(`Invalid ${arg} value: ${value}`);
      }
      options.spawnTimeoutSeconds = parsed;
      i += 1;
      continue;
    }
    if (arg === "--list-packages") {
      const testName = argv[i + 1];
      if (!testName) {
        fail(`Missing value for ${arg}`);
      }
      options.listPackages = testName;
      i += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      fail(`Unknown option: ${arg}`);
    }
    options.tests.push(arg);
  }

  return options;
}

function buildRunFilter(testNames: string[]): string {
  if (testNames.length === 0) {
    return "";
  }
  return testNames.length === 1 ? testNames[0] : testNames.join("|");
}

function loadIndex(indexFilePath: string): ComplementTestIndex {
  if (!fs.existsSync(indexFilePath)) {
    fail(`Complement test index not found: ${indexFilePath}\nRun \`bun run complement:index\` first.`);
  }
  return loadComplementTestIndex(indexFilePath);
}

function resolvePackages(
  indexFilePath: string,
  options: CliOptions,
): { packages: string[]; resolvedByTest: Record<string, string> } {
  if (options.explicitPackages.length > 0) {
    return {
      packages: [...new Set(options.explicitPackages)].sort(),
      resolvedByTest: {},
    };
  }

  if (options.full || options.tests.length === 0) {
    return {
      packages: ["./tests/..."],
      resolvedByTest: {},
    };
  }

  const index = loadIndex(indexFilePath);
  const resolution = resolveComplementPackages(index, options.tests);
  if (resolution.missing.length > 0) {
    console.error("No Complement package mapping found for:");
    for (const testName of resolution.missing) {
      console.error(`  - ${testName}`);
    }
    console.error("Use exact top-level test names, regenerate the index with `bun run complement:index`, or pass --pkg.");
    process.exit(1);
  }
  if (Object.keys(resolution.ambiguous).length > 0) {
    console.error("Ambiguous Complement test package mapping:");
    for (const [testName, packages] of Object.entries(resolution.ambiguous)) {
      console.error(`  - ${testName}: ${packages.join(", ")}`);
    }
    console.error("Pass --pkg to disambiguate.");
    process.exit(1);
  }
  if (resolution.packages.length === 0) {
    fail("No Complement packages resolved.");
  }
  return {
    packages: resolution.packages,
    resolvedByTest: resolution.resolvedByTest,
  };
}

function createComplementEnvironment(input: {
  image: string;
  startupDebug: boolean;
  spawnTimeoutSeconds: number | null;
}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  env.COMPLEMENT_BASE_IMAGE = input.image;
  env.COMPLEMENT_SHARE_ENV_PREFIX = "FAASMATRIX_";
  env.FAASMATRIX_MATRIX_FEATURE_PROFILE = "complement";

  if (input.spawnTimeoutSeconds !== null) {
    env.COMPLEMENT_SPAWN_HS_TIMEOUT_SECS = String(input.spawnTimeoutSeconds);
  }

  if (input.startupDebug) {
    env.COMPLEMENT_ALWAYS_PRINT_SERVER_LOGS = "1";
    env.FAASMATRIX_COMPLEMENT_DEBUG_STARTUP = "1";
    env.FAASMATRIX_WRANGLER_LOG_LEVEL = "info";
  }

  return env;
}

async function listTests(pattern: string): Promise<void> {
  console.log(`==> Listing tests matching: ${pattern}`);
  await $`COMPLEMENT_BASE_IMAGE=${image} go test ./tests/... -list ${pattern}`
    .cwd(complementDir)
    .nothrow();
}

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

function startDockerLogCapture(sidecarLogPath: string, targetImage: string): DockerLogCapture {
  fs.writeFileSync(sidecarLogPath, "");
  const logFd = fs.openSync(sidecarLogPath, "a");
  const followers = new Map<string, { proc: ChildProcessWithoutNullStreams; done: Promise<void> }>();
  const seenContainers = new Set<string>();
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
    if (stopped || followers.has(containerId) || seenContainers.has(containerId)) {
      return;
    }
    seenContainers.add(containerId);

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

  scanPromise = (async () => {
    while (!stopped) {
      await scanRunningContainers();
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  })();

  return {
    async stop() {
      stopped = true;
      if (scanPromise) {
        await scanPromise.catch(() => undefined);
      }
      for (const { proc } of followers.values()) {
        proc.kill("SIGTERM");
      }
      await Promise.all([...followers.values()].map(({ done }) => done));
      fs.closeSync(logFd);
    },
  };
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
