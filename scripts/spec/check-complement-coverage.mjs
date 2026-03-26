import { writeFile } from "node:fs/promises";
import { complementCoverageReportPath } from "./paths.mjs";
import { loadChecklistIndex } from "./complement-parser.mjs";
import { loadComplementMap } from "./load-complement-map.mjs";

async function main() {
  const { checklistRepoPath, rows, index } = await loadChecklistIndex();
  const complementMap = await loadComplementMap();
  const rowsById = complementMap.rowsById || {};

  const missingRowIds = [];
  const unknownRowIds = [];
  const duplicateTests = [];
  const invalidTests = [];
  const legacyTitleRows = Object.keys(complementMap.rows || {});

  for (const row of rows) {
    if (!rowsById[row.rowId]) {
      missingRowIds.push({
        rowId: row.rowId,
        section: row.section,
        title: row.title,
      });
    }
  }

  for (const [rowId, entry] of Object.entries(rowsById)) {
    if (!index.byRowId.has(rowId)) {
      unknownRowIds.push({
        rowId,
        title: entry.title || "",
      });
      continue;
    }

    const tests = entry.tests || [];
    const seen = new Set();
    for (const test of tests) {
      if (!test.file || !test.why) {
        invalidTests.push({ rowId, test });
        continue;
      }
      const key = `${test.file}::${test.why}`;
      if (seen.has(key)) {
        duplicateTests.push({ rowId, test });
        continue;
      }
      seen.add(key);
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    checklist: checklistRepoPath,
    checklistRowCount: rows.length,
    mappedRowCount: Object.keys(rowsById).length,
    missingRowIdCount: missingRowIds.length,
    unknownRowIdCount: unknownRowIds.length,
    invalidTestCount: invalidTests.length,
    duplicateTestCount: duplicateTests.length,
    legacyTitleRowCount: legacyTitleRows.length,
    missingRowIds,
    unknownRowIds,
    invalidTests,
    duplicateTests,
    legacyTitleRows,
  };

  await writeFile(complementCoverageReportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(`Checklist rows: ${report.checklistRowCount}`);
  console.log(`Mapped rows: ${report.mappedRowCount}`);
  console.log(`Missing row IDs: ${report.missingRowIdCount}`);
  console.log(`Unknown row IDs: ${report.unknownRowIdCount}`);
  console.log(`Invalid tests: ${report.invalidTestCount}`);
  console.log(`Duplicate tests: ${report.duplicateTestCount}`);
  console.log(`Legacy title rows: ${report.legacyTitleRowCount}`);

  if (
    missingRowIds.length > 0 ||
    unknownRowIds.length > 0 ||
    invalidTests.length > 0 ||
    duplicateTests.length > 0
  ) {
    process.exitCode = 1;
  }
}

await main();
