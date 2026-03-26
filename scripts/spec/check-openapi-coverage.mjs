import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const unitsPath = path.join(repoRoot, "docs", "spec-coverage", "openapi-units.json");
const mapPath = path.join(repoRoot, "docs", "spec-coverage", "openapi-row-map.json");
const checklistPath = path.join(repoRoot, "docs", "speccheck-matrix-v2.md");
const reportPath = path.join(repoRoot, "docs", "spec-coverage", "openapi-coverage-report.json");

function normalize(value) {
  return value
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function extractChecklistRows(markdown) {
  const rows = new Set();
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("|")) continue;
    if (line.includes("|------")) continue;
    const cells = line.split("|").map((part) => part.trim()).filter(Boolean);
    if (cells.length === 0) continue;
    const firstCell = cells[0];
    if (firstCell === "Area" || firstCell === "Module" || firstCell === "Evidence type") continue;
    rows.add(firstCell);
  }
  return [...rows];
}

async function main() {
  const units = JSON.parse(await readFile(unitsPath, "utf8"));
  const coverageMap = JSON.parse(await readFile(mapPath, "utf8"));
  const checklist = await readFile(checklistPath, "utf8");

  const checklistRows = new Set(extractChecklistRows(checklist).map(normalize));
  const fileUnits = units.units.filter((unit) => unit.kind === "file");

  const missing = [];
  const invalidRows = [];
  const covered = [];

  for (const unit of fileUnits) {
    const key = `${unit.spec}/${unit.file}`;
    const mapping = coverageMap[key];
    if (!mapping) {
      missing.push({ key, reason: "missing-map-entry" });
      continue;
    }

    const rows = mapping.rows || [];
    if (rows.length === 0 && mapping.scope !== "out-of-scope") {
      missing.push({ key, reason: "empty-rows" });
      continue;
    }

    const unresolvedRows = rows.filter((row) => !checklistRows.has(normalize(row)));
    if (unresolvedRows.length > 0) {
      invalidRows.push({ key, rows: unresolvedRows });
      continue;
    }

    covered.push({
      key,
      scope: mapping.scope || "tracked",
      rows,
      operationCount: units.units.filter(
        (candidate) => candidate.kind === "operation" && candidate.spec === unit.spec && candidate.file === unit.file,
      ).length,
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    checklist: "docs/speccheck-matrix-v2.md",
    openApiFileCount: fileUnits.length,
    coveredCount: covered.length,
    missingCount: missing.length,
    invalidRowCount: invalidRows.length,
    missing,
    invalidRows,
    covered,
  };

  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(`OpenAPI files: ${report.openApiFileCount}`);
  console.log(`Covered: ${report.coveredCount}`);
  console.log(`Missing map entries: ${report.missingCount}`);
  console.log(`Invalid checklist rows: ${report.invalidRowCount}`);

  if (missing.length > 0) {
    for (const item of missing) {
      console.log(`MISSING ${item.key} (${item.reason})`);
    }
  }

  if (invalidRows.length > 0) {
    for (const item of invalidRows) {
      console.log(`INVALID ${item.key} -> ${item.rows.join(", ")}`);
    }
  }

  if (missing.length > 0 || invalidRows.length > 0) {
    process.exitCode = 1;
  }
}

await main();
