import { spawnSync } from "node:child_process";
import { relative, resolve } from "node:path";
import ts from "typescript";

const targets = [
  "src/fatrix-backend/application/domain-error.ts",
  "src/fatrix-backend/application/runtime/effect-debug.ts",
  "src/fatrix-backend/application/runtime/effect-runtime.ts",
  "src/fatrix-backend/application/logging.ts",
  "src/fatrix-backend/application/features/presence",
  "src/fatrix-backend/application/features/typing",
  "src/fatrix-backend/application/features/to-device",
  "src/fatrix-backend/application/features/device-lists",
  "src/fatrix-backend/application/federation/transactions",
  "src/fatrix-backend/application/federation/query",
  "src/fatrix-backend/application/federation/membership",
  "src/fatrix-backend/application/federation/e2ee",
  "src/fatrix-backend/application/federation/events",
  "src/fatrix-backend/application/features/invite-permissions",
  "src/fatrix-backend/application/features/partial-state",
  "src/fatrix-backend/application/features/sync",
  "src/fatrix-backend/application/orchestrators/room-service.ts",
  "src/fatrix-backend/application/room-validation.ts",
  "src/fatrix-backend/application/room-membership-policy.ts",
  "src/fatrix-backend/application/membership-transition-service.ts",
  "src/fatrix-backend/application/legacy/federation-service.ts",
  "src/platform/cloudflare/matrix-repositories.ts",
  "src/platform/cloudflare/adapters/db/database.ts",
  "src/fatrix-api/presence.ts",
  "src/fatrix-api/sync.ts",
  "src/fatrix-api/typing.ts",
  "src/fatrix-api/to-device.ts",
  "src/fatrix-api/keys.ts",
  "src/fatrix-model/types/keys-contracts.ts",
  "src/fatrix-api/push.ts",
  "src/fatrix-model/types/push-contracts.ts",
  "src/platform/cloudflare/workflows/RoomJoinWorkflow.ts",
  "src/fatrix-model/types/workflows.ts",
];

const rg = spawnSync("rg", ["--files", ...targets], {
  cwd: process.cwd(),
  encoding: "utf8",
});

if (rg.status !== 0) {
  process.stderr.write(rg.stderr ?? "");
  process.exit(rg.status ?? 1);
}

const rootNames = (rg.stdout ?? "")
  .trim()
  .split("\n")
  .map((file) => file.trim())
  .filter(Boolean)
  .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
  .map((file) => resolve(process.cwd(), file));

const configPath = resolve(process.cwd(), "tsconfig.strict-core.json");
const configFile = ts.readConfigFile(configPath, ts.sys.readFile);

if (configFile.error) {
  process.stderr.write(
    ts.formatDiagnosticsWithColorAndContext([configFile.error], {
      getCanonicalFileName: (fileName) => fileName,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => "\n",
    }),
  );
  process.exit(1);
}

const parsed = ts.parseJsonConfigFileContent(
  configFile.config,
  ts.sys,
  process.cwd(),
  undefined,
  configPath,
);

const program = ts.createProgram({
  rootNames,
  options: parsed.options,
});

const rootSet = new Set(
  rootNames.map((fileName) => relative(process.cwd(), fileName).replaceAll("\\", "/")),
);

const diagnostics = ts.getPreEmitDiagnostics(program).filter((diagnostic) => {
  if (!diagnostic.file) {
    return true;
  }

  const fileName = relative(process.cwd(), diagnostic.file.fileName).replaceAll("\\", "/");
  return rootSet.has(fileName);
});

if (diagnostics.length === 0) {
  process.exit(0);
}

process.stderr.write(
  ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => process.cwd(),
    getNewLine: () => "\n",
  }),
);
process.exit(1);
