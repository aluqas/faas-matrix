import { spawnSync } from "node:child_process";

const targets = ["src"];

const rgArgs = [
  "--line-number",
  "--glob",
  "!**/*.test.ts",
  "Effect\\.runPromise\\(",
  ...targets,
];

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

const allowedFiles = new Set([
  "src/matrix/application/effect-runtime.ts",
]);

const violations = (result.stdout ?? "")
  .trim()
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean)
  .filter((line) => {
    const [file] = line.split(":", 2);
    return !allowedFiles.has(file);
  });

if (violations.length === 0) {
  process.exit(0);
}

process.stderr.write("Effect.runPromise is only allowed in effect-runtime.ts and tests:\n");
process.stderr.write(`${violations.join("\n")}\n`);
process.exit(1);
