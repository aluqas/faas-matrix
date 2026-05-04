import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
