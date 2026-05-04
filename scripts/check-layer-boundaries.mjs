import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs"];

const missingLegacyDirectories = ["api", "features", "infra", "matrix", "shared"].map(
  (name) => `src/${name}`,
);

const applicationPlatformImportBaseline = new Set([
  "src/fatrix-backend/application/features/client-keys/claim.ts",
  "src/fatrix-backend/application/features/client-keys/cross-signing.ts",
  "src/fatrix-backend/application/features/client-keys/query.ts",
  "src/fatrix-backend/application/features/client-keys/uia.ts",
  "src/fatrix-backend/application/features/client-keys/upload.ts",
  "src/fatrix-backend/application/features/partial-state/shared-servers.ts",
  "src/fatrix-backend/application/features/presence/project.ts",
  "src/fatrix-backend/application/federation/membership/invite.ts",
  "src/fatrix-backend/application/federation/membership/make-join.ts",
  "src/fatrix-backend/application/federation/membership/make-knock.ts",
  "src/fatrix-backend/application/federation/membership/make-leave.ts",
  "src/fatrix-backend/application/federation/membership/send-join.ts",
  "src/fatrix-backend/application/federation/membership/send-knock.ts",
  "src/fatrix-backend/application/federation/membership/send-leave.ts",
  "src/fatrix-backend/application/federation/membership/third-party-invite.ts",
  "src/fatrix-backend/application/federation/transactions/pdu-ingest.ts",
  "src/fatrix-backend/application/legacy/federation-query-service.ts",
  "src/fatrix-backend/application/membership-transition-service.ts",
  "src/fatrix-backend/application/orchestrators/event-query-service.ts",
  "src/fatrix-backend/application/orchestrators/federation-handler-service.ts",
  "src/fatrix-backend/application/orchestrators/room-service.ts",
  "src/fatrix-backend/application/relationship-service.ts",
  "src/fatrix-backend/application/room-query-service.ts",
]);

function toPosix(path) {
  return path.replaceAll("\\", "/");
}

function walk(directory, output = []) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      walk(path, output);
      continue;
    }
    if (SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension))) {
      output.push(toPosix(relative(ROOT, path)));
    }
  }
  return output;
}

function resolveRelativeImport(fromFile, specifier) {
  if (!specifier.startsWith(".")) {
    return null;
  }
  const base = toPosix(normalize(join(dirname(fromFile), specifier)));
  const candidates = [
    base,
    ...SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...SOURCE_EXTENSIONS.map((extension) => `${base}/index${extension}`),
  ];
  return candidates.find((candidate) => allFiles.has(candidate)) ?? base;
}

function resolveAliasImport(specifier) {
  if (!specifier.startsWith("@/")) {
    return null;
  }
  const base = `src/${specifier.slice(2)}`;
  const candidates = [
    base,
    ...SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...SOURCE_EXTENSIONS.map((extension) => `${base}/index${extension}`),
  ];
  return candidates.find((candidate) => allFiles.has(candidate)) ?? base;
}

function resolveImport(fromFile, specifier) {
  return resolveRelativeImport(fromFile, specifier) ?? resolveAliasImport(specifier);
}

function layerOf(path) {
  if (path.startsWith("src/fetherate/")) return "fetherate";
  if (path.startsWith("src/fatrix-model/")) return "fatrix-model";
  if (path.startsWith("src/fatrix-backend/")) return "fatrix-backend";
  if (path.startsWith("src/fatrix-api/")) return "fatrix-api";
  if (path.startsWith("src/platform/cloudflare/")) return "platform/cloudflare";
  return "other";
}

const files = walk(SRC);
const allFiles = new Set(files);
const violations = [];

for (const legacyDirectory of missingLegacyDirectories) {
  try {
    statSync(legacyDirectory);
    violations.push(`${legacyDirectory} should not exist after the fatrix split`);
  } catch {
    // Expected.
  }
}

const importPattern =
  /(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

for (const file of files) {
  const source = readFileSync(join(ROOT, file), "utf8");
  const fromLayer = layerOf(file);
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1] ?? match[2];
    const target = resolveImport(file, specifier);
    if (!target) {
      continue;
    }
    const toLayer = layerOf(target);
    if (fromLayer === "fatrix-backend" && toLayer === "fatrix-api") {
      violations.push(`${file} imports ${target}; fatrix-backend must not depend on fatrix-api`);
    }
    if (
      file.startsWith("src/fatrix-backend/application/") &&
      toLayer === "platform/cloudflare" &&
      !applicationPlatformImportBaseline.has(file)
    ) {
      violations.push(
        `${file} imports ${target}; fatrix-backend/application must not add platform/cloudflare dependencies`,
      );
    }
    if (fromLayer === "fatrix-model" && toLayer !== "fatrix-model" && toLayer !== "fetherate") {
      violations.push(`${file} imports ${target}; fatrix-model must stay pure`);
    }
    if (fromLayer === "fetherate" && toLayer !== "fetherate") {
      violations.push(`${file} imports ${target}; fetherate must not depend on app layers`);
    }
    if (target.startsWith("src/api/") || target.startsWith("src/features/") || target.startsWith("src/infra/") || target.startsWith("src/matrix/") || target.startsWith("src/shared/")) {
      violations.push(`${file} imports removed legacy path ${target}`);
    }
  }
}

if (violations.length > 0) {
  process.stderr.write("Layer boundary violations found:\n");
  process.stderr.write(`${violations.join("\n")}\n`);
  process.exit(1);
}
