import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const targets = [
  "src/matrix/application/domain-error.ts",
  "src/matrix/application/effect-debug.ts",
  "src/matrix/application/effect-runtime.ts",
  "src/matrix/application/logging.ts",
  "src/matrix/application/features/presence",
  "src/matrix/application/features/typing",
  "src/matrix/application/features/to-device",
  "src/matrix/application/features/device-lists",
  "src/matrix/application/features/federation",
  "src/matrix/application/features/invite-permissions",
  "src/matrix/application/features/partial-state",
  "src/matrix/application/features/sync",
  "src/matrix/application/room-service.ts",
  "src/matrix/application/room-validation.ts",
  "src/matrix/application/room-membership-policy.ts",
  "src/matrix/application/member-transition-service.ts",
  "src/matrix/application/federation-service.ts",
  "src/runtime/cloudflare/matrix-repositories.ts",
  "src/services/database.ts",
  "src/api/presence.ts",
  "src/api/sync.ts",
  "src/api/typing.ts",
  "src/api/to-device.ts",
  "src/api/keys.ts",
  "src/api/keys-contracts.ts",
  "src/api/push.ts",
  "src/api/push-contracts.ts",
  "src/workflows/RoomJoinWorkflow.ts",
  "src/types/workflows.ts",
];

const rgArgs = ["--line-number", "--glob", "!**/*.test.ts", String.raw`\bany\b`, ...targets];

const result = spawnSync("rg", rgArgs, {
  cwd: process.cwd(),
  encoding: "utf8",
});

if (result.status === 1) {
  process.exit(0);
}

if (result.status !== 0) {
  process.stderr.write(result.stderr ?? "");
  process.exit(result.status ?? 1);
}

const matches = (result.stdout ?? "")
  .trim()
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean)
  .filter((line) => {
    const [file, lineNumber] = line.split(":", 3);
    if (!file || !lineNumber) {
      return false;
    }

    const source = readFileSync(resolve(process.cwd(), file), "utf8");
    const sourceLine = source.split("\n")[Number.parseInt(lineNumber, 10) - 1] ?? "";
    return /\bany\b/.test(sourceLine);
  });

if (matches.length === 0) {
  process.exit(0);
}

process.stderr.write("Explicit any is forbidden in strict-core paths:\n");
process.stderr.write(`${matches.join("\n")}\n`);
process.exit(1);
