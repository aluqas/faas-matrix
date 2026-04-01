import { spawnSync } from "node:child_process";
import { relative, resolve } from "node:path";
import ts from "typescript";

const targets = [
  "src/matrix/application/domain-error.ts",
  "src/matrix/application/effect-debug.ts",
  "src/matrix/application/effect-runtime.ts",
  "src/matrix/application/logging.ts",
  "src/matrix/application/features/presence",
  "src/matrix/application/features/typing",
  "src/matrix/application/features/to-device",
  "src/matrix/application/features/device-lists",
  "src/matrix/application/features/invite-permissions",
  "src/matrix/application/features/partial-state",
  "src/matrix/application/room-service.ts",
  "src/matrix/application/room-validation.ts",
  "src/matrix/application/room-membership-policy.ts",
  "src/matrix/application/member-transition-service.ts",
  "src/runtime/cloudflare/matrix-repositories.ts",
  "src/services/database.ts",
  "src/api/presence.ts",
  "src/api/typing.ts",
  "src/api/to-device.ts",
  "src/api/keys.ts",
  "src/api/keys-contracts.ts",
  "src/api/push.ts",
  "src/api/push-contracts.ts",
  "src/workflows/RoomJoinWorkflow.ts",
  "src/types/workflows.ts",
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
