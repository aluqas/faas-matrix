import fs from "fs";
import path from "path";
import { parseLog, summarize, type Summary } from "./complement-log.ts";

export type FailureClassification = "implementation_fail" | "startup_flake" | "infra_flake";
export type OverallClassification = FailureClassification | "mixed" | null;
export type ComplementTestIndex = Record<string, string[]>;

export interface PackageResolution {
  packages: string[];
  missing: string[];
  ambiguous: Record<string, string[]>;
  resolvedByTest: Record<string, string>;
}

export interface ClassifiedFailure {
  test: string;
  classification: FailureClassification;
  reasons: string[];
}

export interface ClassifiedRun {
  overallClassification: OverallClassification;
  failures: ClassifiedFailure[];
}

export interface RunSummaryArtifact extends Summary {
  generatedAt: string;
  packages: string[];
  filter: string | null;
  requestedTests: string[];
  fullRun: boolean;
  startupDebug: boolean;
  spawnTimeoutSeconds: number | null;
  overallClassification: OverallClassification;
  failedTests: ClassifiedFailure[];
}

const INFRA_PATTERNS = [
  { id: "docker_daemon", regex: /Cannot connect to the Docker daemon|permission denied while trying to connect to the Docker daemon/i },
  { id: "docker_build", regex: /failed to solve|pull access denied|no space left on device|docker build/i },
  {
    id: "transport_skew",
    regex: /certificate is not yet valid|TLS peer's certificate is not trusted|network connection lost/i,
  },
];

const STARTUP_PATTERNS = [
  { id: "deploy_base_image", regex: /failed to deployBaseImage/i },
  { id: "health_starting", regex: /health: starting/i },
  { id: "server_up_timeout", regex: /failed to check server is up|timed out checking for homeserver to be up/i },
];

export function topLevelTestName(testName: string): string {
  return testName.split("/")[0] ?? testName;
}

export function extractTestsFromGoFile(content: string): string[] {
  const matches = content.matchAll(/^\s*func\s+(Test[A-Za-z0-9_]+)\s*\(/gm);
  const tests = new Set<string>();
  for (const match of matches) {
    const testName = match[1];
    if (testName) {
      tests.add(testName);
    }
  }
  return [...tests].sort();
}

function walkFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith("_test.go")) {
      files.push(fullPath);
    }
  }
  return files;
}

function toGoPackagePath(testsRoot: string, filePath: string): string {
  const relDir = path.relative(testsRoot, path.dirname(filePath)).split(path.sep).join("/");
  return relDir === "" ? "./tests" : `./tests/${relDir}`;
}

export function buildComplementTestIndex(testsRoot: string): ComplementTestIndex {
  const index = new Map<string, Set<string>>();
  for (const filePath of walkFiles(testsRoot)) {
    const content = fs.readFileSync(filePath, "utf8");
    const packagePath = toGoPackagePath(testsRoot, filePath);
    for (const testName of extractTestsFromGoFile(content)) {
      const packages = index.get(testName) ?? new Set<string>();
      packages.add(packagePath);
      index.set(testName, packages);
    }
  }

  const sorted: ComplementTestIndex = {};
  for (const [testName, packages] of [...index.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    sorted[testName] = [...packages].sort();
  }
  return sorted;
}

export function loadComplementTestIndex(indexPath: string): ComplementTestIndex {
  return JSON.parse(fs.readFileSync(indexPath, "utf8")) as ComplementTestIndex;
}

export function resolveComplementPackages(
  index: ComplementTestIndex,
  requestedTests: string[],
): PackageResolution {
  const packages = new Set<string>();
  const missing: string[] = [];
  const ambiguous: Record<string, string[]> = {};
  const resolvedByTest: Record<string, string> = {};

  for (const requestedTest of requestedTests) {
    const topLevel = topLevelTestName(requestedTest);
    const candidates = index[topLevel];
    if (!candidates || candidates.length === 0) {
      missing.push(requestedTest);
      continue;
    }
    if (candidates.length > 1) {
      ambiguous[requestedTest] = candidates;
      continue;
    }
    const resolvedPackage = candidates[0];
    if (!resolvedPackage) {
      missing.push(requestedTest);
      continue;
    }
    packages.add(resolvedPackage);
    resolvedByTest[requestedTest] = resolvedPackage;
  }

  return {
    packages: [...packages].sort(),
    missing: [...missing].sort(),
    ambiguous,
    resolvedByTest,
  };
}

function collectOutputsByTopLevelTest(logContent: string): Record<string, string[]> {
  const outputsByTest: Record<string, string[]> = {};

  for (const line of logContent.split("\n")) {
    if (!line) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as { Test?: unknown; Output?: unknown };
      if (typeof parsed.Output !== "string" || parsed.Output.length === 0) {
        continue;
      }
      const output = parsed.Output.trimEnd();
      const testName = typeof parsed.Test === "string" ? topLevelTestName(parsed.Test) : "__package__";
      if (!outputsByTest[testName]) {
        outputsByTest[testName] = [];
      }
      outputsByTest[testName]?.push(output);
    } catch {
      continue;
    }
  }

  return outputsByTest;
}

function classifyFailureText(
  text: string,
  dockerLogContent: string | null,
): { classification: FailureClassification; reasons: string[] } {
  const infraReasons = INFRA_PATTERNS.filter(({ regex }) => regex.test(text)).map(({ id }) => id);
  if (infraReasons.length > 0) {
    return { classification: "infra_flake", reasons: infraReasons };
  }

  const startupReasons = STARTUP_PATTERNS.filter(({ regex }) => regex.test(text)).map(({ id }) => id);
  if (startupReasons.length > 0) {
    const hasServerLogsSection = /Server logs:/i.test(text);
    const dockerHasSubstantiveOutput =
      dockerLogContent !== null &&
      dockerLogContent
        .split("\n")
        .some(
          (line) =>
            line.startsWith("[docker:") &&
            !line.includes("closed code=") &&
            !line.includes("Error response from daemon"),
        );
    if (hasServerLogsSection && !dockerHasSubstantiveOutput) {
      startupReasons.push("empty_server_logs");
    }
    return { classification: "startup_flake", reasons: startupReasons };
  }

  return { classification: "implementation_fail", reasons: ["assertion_or_behavior_mismatch"] };
}

export function classifyComplementRun(
  logContent: string,
  dockerLogContent: string | null,
): ClassifiedRun {
  const results = parseLog(logContent, 0);
  const summary = summarize(results);
  const outputsByTest = collectOutputsByTopLevelTest(logContent);
  const packageOutput = outputsByTest["__package__"]?.join("\n") ?? "";

  const failures = summary.fails
    .slice()
    .sort()
    .map((test) => {
      const testOutput = outputsByTest[test]?.join("\n") ?? "";
      const combined = [packageOutput, testOutput].filter(Boolean).join("\n");
      const classified = classifyFailureText(combined, dockerLogContent);
      return {
        test,
        classification: classified.classification,
        reasons: classified.reasons,
      };
    });

  const uniqueClassifications = new Set(failures.map((failure) => failure.classification));
  const overallClassification =
    failures.length === 0
      ? null
      : uniqueClassifications.size === 1
        ? failures[0]?.classification ?? null
        : "mixed";

  return {
    overallClassification,
    failures,
  };
}

export function buildRunSummaryArtifact(input: {
  logContent: string;
  dockerLogContent: string | null;
  packages: string[];
  filter: string | null;
  requestedTests: string[];
  fullRun: boolean;
  startupDebug: boolean;
  spawnTimeoutSeconds: number | null;
}): RunSummaryArtifact {
  const results = parseLog(input.logContent, 0);
  const summary = summarize(results);
  const classified = classifyComplementRun(input.logContent, input.dockerLogContent);

  return {
    generatedAt: new Date().toISOString(),
    packages: input.packages,
    filter: input.filter,
    requestedTests: input.requestedTests,
    fullRun: input.fullRun,
    startupDebug: input.startupDebug,
    spawnTimeoutSeconds: input.spawnTimeoutSeconds,
    pass: summary.pass,
    fail: summary.fail,
    skip: summary.skip,
    total: summary.total,
    fails: summary.fails,
    overallClassification: classified.overallClassification,
    failedTests: classified.failures,
  };
}

export function printRunSummary(summary: RunSummaryArtifact): void {
  console.log();
  console.log("=".repeat(60));
  console.log(`  PACKAGES: ${summary.packages.join(", ") || "(none)"}`);
  console.log(
    `  PASS: ${summary.pass}  FAIL: ${summary.fail}  SKIP: ${summary.skip}  CLASSIFICATION: ${summary.overallClassification ?? "clean"}`,
  );
  console.log("=".repeat(60));

  if (summary.failedTests.length > 0) {
    console.log("\nFAILED:");
    for (const failure of summary.failedTests) {
      console.log(`  ✗ ${failure.test} [${failure.classification}] (${failure.reasons.join(", ")})`);
    }
  }
}

export function writeJsonArtifact(artifactPath: string, value: unknown): void {
  fs.writeFileSync(artifactPath, `${JSON.stringify(value, null, 2)}\n`);
}
