import { readFile, writeFile } from "node:fs/promises";
import {
  checklistPath,
  checklistRepoPath,
  coverageReportPath,
  matrixSpecUnitsPath,
  titleAliasesPath,
} from "./paths.mjs";

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
    if (firstCell === "Area" || firstCell === "Module" || firstCell === "Evidence type") {
      continue;
    }
    rows.add(firstCell);
  }
  return [...rows];
}

async function main() {
  const units = JSON.parse(await readFile(matrixSpecUnitsPath, "utf8"));
  const aliases = JSON.parse(await readFile(titleAliasesPath, "utf8"));
  const checklist = await readFile(checklistPath, "utf8");

  const rowTitles = extractChecklistRows(checklist);
  const normalizedRows = new Set(rowTitles.map(normalize));
  const aliasMap = new Map(
    aliases.map((entry) => [normalize(entry.specTitle), normalize(entry.checklistTitle)]),
  );

  const covered = [];
  const missing = [];

  for (const unit of units.primaryUnits) {
    const normalizedTitle = normalize(unit.title);
    const aliasTitle = aliasMap.get(normalizedTitle);
    if (normalizedRows.has(normalizedTitle) || (aliasTitle && normalizedRows.has(aliasTitle))) {
      covered.push(unit);
    } else {
      missing.push(unit);
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    checklist: checklistRepoPath,
    primaryUnitCount: units.primaryUnits.length,
    coveredCount: covered.length,
    missingCount: missing.length,
    missing,
  };

  await writeFile(coverageReportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(`Primary units: ${report.primaryUnitCount}`);
  console.log(`Covered: ${report.coveredCount}`);
  console.log(`Missing: ${report.missingCount}`);

  if (missing.length > 0) {
    for (const unit of missing) {
      console.log(`MISSING ${unit.title} (${unit.source})`);
    }
    process.exitCode = 1;
  }
}

await main();
