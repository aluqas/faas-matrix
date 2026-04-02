#!/usr/bin/env bun

import { mkdtempSync, mkdirSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { $ } from "bun";

interface CliOptions {
  iterations: number;
  timeoutSeconds: number;
  image: string;
  reuseDataDir: boolean;
  keepDataDir: boolean;
  instances: number;
}

interface PhaseTiming {
  event: string;
  secondsFromBegin: number;
}

interface InstanceResult {
  name: string;
  readySeconds: number | null;
  status: "ready" | "timeout" | "error";
  hostPort: number | null;
  phaseTimings: PhaseTiming[];
  dataDir: string;
  error?: string;
}

interface IterationResult {
  iteration: number;
  readySeconds: number | null;
  status: "ready" | "timeout" | "error";
  instances: InstanceResult[];
}

const options = parseArgs(process.argv.slice(2));
const dataRoot = mkdtempSync(path.join(os.tmpdir(), "complement-startup-"));
const sharedDataDir = path.join(dataRoot, "shared-data");
if (options.reuseDataDir) {
  mkdirSync(sharedDataDir, { recursive: true });
}

const results: IterationResult[] = [];

try {
  for (let iteration = 1; iteration <= options.iterations; iteration += 1) {
    const iterationRoot = options.reuseDataDir ? sharedDataDir : path.join(dataRoot, `data-${iteration}`);
    mkdirSync(iterationRoot, { recursive: true });
    const result = await runIteration(iteration, iterationRoot, options);
    results.push(result);
    printIteration(result);
  }

  printSummary(results, options);
} finally {
  if (!options.keepDataDir) {
    rmSync(dataRoot, { recursive: true, force: true });
  } else {
    console.log(`Data dir kept at: ${dataRoot}`);
  }
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    iterations: 2,
    timeoutSeconds: 40,
    image: process.env.IMAGE ?? "complement-faas-matrix",
    reuseDataDir: true,
    keepDataDir: false,
    instances: 1,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--iterations") {
      const value = argv[i + 1];
      if (!value) {
        fail(`Missing value for ${arg}`);
      }
      options.iterations = parsePositiveInt(value, arg);
      i += 1;
      continue;
    }
    if (arg === "--timeout") {
      const value = argv[i + 1];
      if (!value) {
        fail(`Missing value for ${arg}`);
      }
      options.timeoutSeconds = parsePositiveInt(value, arg);
      i += 1;
      continue;
    }
    if (arg === "--image") {
      const value = argv[i + 1];
      if (!value) {
        fail(`Missing value for ${arg}`);
      }
      options.image = value;
      i += 1;
      continue;
    }
    if (arg === "--instances") {
      const value = argv[i + 1];
      if (!value) {
        fail(`Missing value for ${arg}`);
      }
      options.instances = parsePositiveInt(value, arg);
      i += 1;
      continue;
    }
    if (arg === "--fresh-data") {
      options.reuseDataDir = false;
      continue;
    }
    if (arg === "--keep-data-dir") {
      options.keepDataDir = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    fail(`Unknown argument: ${arg}`);
  }

  return options;
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    fail(`Invalid ${flag} value: ${value}`);
  }
  return parsed;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function printHelp(): void {
  console.log("Usage: bun run scripts/complement-startup-preflight.ts [options]");
  console.log("  --iterations <n>   number of startup iterations (default: 2)");
  console.log("  --timeout <sec>    readiness timeout in seconds (default: 40)");
  console.log("  --image <name>     docker image to run (default: complement-faas-matrix)");
  console.log("  --instances <n>    number of homeserver containers per iteration (default: 1)");
  console.log("  --fresh-data       do not reuse /data across iterations");
  console.log("  --keep-data-dir    keep the temporary /data directory after the run");
}

async function runIteration(
  iteration: number,
  iterationRoot: string,
  options: CliOptions,
): Promise<IterationResult> {
  const promises: Promise<InstanceResult>[] = [];
  for (let instanceIndex = 1; instanceIndex <= options.instances; instanceIndex += 1) {
    const name = `hs${instanceIndex}`;
    const dataDir = path.join(iterationRoot, name);
    mkdirSync(dataDir, { recursive: true });
    promises.push(runInstance(iteration, name, dataDir, options));
  }
  const instances = await Promise.all(promises);
  const statuses = new Set(instances.map((instance) => instance.status));
  const readyTimes = instances
    .map((instance) => instance.readySeconds)
    .filter((value): value is number => value !== null);

  let status: IterationResult["status"] = "ready";
  if (statuses.has("error")) {
    status = "error";
  } else if (statuses.has("timeout")) {
    status = "timeout";
  }

  return {
    iteration,
    readySeconds: readyTimes.length === options.instances ? Math.max(...readyTimes) : null,
    status,
    instances,
  };
}

async function runInstance(
  iteration: number,
  name: string,
  dataDir: string,
  options: CliOptions,
): Promise<InstanceResult> {
  const containerName = `faas-matrix-startup-${process.pid}-${Date.now()}-${iteration}-${name}`;
  let containerStarted = false;
  try {
    const runOutput = await $`docker run -d --rm --name ${containerName} -p 127.0.0.1::8008 -v ${dataDir}:/data -e MATRIX_FEATURE_PROFILE=complement -e SERVER_NAME=${name} ${options.image}`.text();
    const containerId = runOutput.trim();
    if (!containerId) {
      return {
        name,
        readySeconds: null,
        status: "error",
        hostPort: null,
        phaseTimings: [],
        dataDir,
        error: "docker run did not return a container id",
      };
    }
    containerStarted = true;

    const hostPort = await resolveHostPort(containerName);
    if (hostPort === null) {
      return {
        name,
        readySeconds: null,
        status: "error",
        hostPort: null,
        phaseTimings: [],
        dataDir,
        error: "could not resolve mapped port for 8008/tcp",
      };
    }

    const start = Date.now();
    let readySeconds: number | null = null;
    while ((Date.now() - start) / 1000 < options.timeoutSeconds) {
      if (await isReady(hostPort)) {
        readySeconds = (Date.now() - start) / 1000;
        break;
      }
      await Bun.sleep(250);
    }

    const logs = await $`zsh -lc ${`docker logs ${containerName} 2>&1`}`.nothrow().text();
    const phaseTimings = parsePhaseTimings(logs);

    return {
      name,
      readySeconds,
      status: readySeconds === null ? "timeout" : "ready",
      hostPort,
      phaseTimings,
      dataDir,
      error: readySeconds === null ? `did not become ready within ${options.timeoutSeconds}s` : undefined,
    };
  } catch (error) {
    return {
      name,
      readySeconds: null,
      status: "error",
      hostPort: null,
      phaseTimings: [],
      dataDir,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (containerStarted) {
      await $`docker rm -f ${containerName}`.nothrow().quiet();
    }
  }
}

async function resolveHostPort(containerName: string): Promise<number | null> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const output = (await $`docker port ${containerName} 8008/tcp`.nothrow().text()).trim();
    const match = output.match(/:(\d+)$/);
    if (match) {
      return Number.parseInt(match[1], 10);
    }
    await Bun.sleep(250);
  }
  return null;
}

async function isReady(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/_internal/ready`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function parsePhaseTimings(logs: string): PhaseTiming[] {
  const timings: PhaseTiming[] = [];
  let beginTime: number | null = null;

  for (const line of logs.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    let parsed: { ts?: string; event?: string };
    try {
      parsed = JSON.parse(trimmed) as { ts?: string; event?: string };
    } catch {
      continue;
    }
    if (typeof parsed.event !== "string" || !parsed.event.startsWith("startup.")) {
      continue;
    }
    const ts = typeof parsed.ts === "string" ? Date.parse(parsed.ts) : NaN;
    if (!Number.isFinite(ts)) {
      continue;
    }
    if (parsed.event === "startup.begin") {
      beginTime = ts;
    }
    if (beginTime === null) {
      continue;
    }
    timings.push({
      event: parsed.event,
      secondsFromBegin: (ts - beginTime) / 1000,
    });
  }

  return timings;
}

function printIteration(result: IterationResult): void {
  console.log(`iteration ${result.iteration}: ${result.status}`);
  console.log(`  overall ready: ${result.readySeconds !== null ? `${result.readySeconds.toFixed(2)}s` : "-"}`);
  for (const instance of result.instances) {
    console.log(`  ${instance.name}: ${instance.status}`);
    console.log(`    host port: ${instance.hostPort ?? "-"}`);
    console.log(`    ready: ${instance.readySeconds !== null ? `${instance.readySeconds.toFixed(2)}s` : "-"}`);
    if (instance.error) {
      console.log(`    error: ${instance.error}`);
    }
    for (const timing of instance.phaseTimings) {
      console.log(`    ${timing.event}: ${timing.secondsFromBegin.toFixed(2)}s`);
    }
  }
}

function printSummary(results: IterationResult[], options: CliOptions): void {
  const ready = results.filter((result) => result.readySeconds !== null);
  const readyTimes = ready.map((result) => result.readySeconds as number);
  const average =
    readyTimes.length === 0 ? null : readyTimes.reduce((sum, value) => sum + value, 0) / readyTimes.length;
  const worst = readyTimes.length === 0 ? null : Math.max(...readyTimes);
  console.log("");
  console.log("startup summary");
  console.log(`  image: ${options.image}`);
  console.log(`  iterations: ${options.iterations}`);
  console.log(`  instances: ${options.instances}`);
  console.log(`  reuse data dir: ${options.reuseDataDir ? "yes" : "no"}`);
  console.log(`  timeout: ${options.timeoutSeconds}s`);
  console.log(`  ready count: ${ready.length}/${results.length}`);
  console.log(`  average ready: ${average === null ? "-" : `${average.toFixed(2)}s`}`);
  console.log(`  worst ready: ${worst === null ? "-" : `${worst.toFixed(2)}s`}`);
}
