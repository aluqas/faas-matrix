import { readFile, writeFile } from "node:fs/promises";
import {
  checklistPath,
  checklistRepoPath,
  coverageReportPath,
  matrixSpecUnitsPath,
  titleAliasesPath,
} from "./paths.mjs";
import {
  buildChecklistIndex,
  extractChecklistRows,
  findRowsByTitle,
  getSectionForSpecUnit,
  normalize,
} from "./checklist-parser.mjs";

async function main() {
  const units = JSON.parse(await readFile(matrixSpecUnitsPath, "utf8"));
  const aliases = JSON.parse(await readFile(titleAliasesPath, "utf8"));
  const checklist = await readFile(checklistPath, "utf8");

  const checklistRows = extractChecklistRows(checklist);
  const checklistIndex = buildChecklistIndex(checklistRows);
  const knownUnitIds = new Set(units.primaryUnits.map((unit) => unit.id));
  const aliasBySpecUnitId = new Map();
  const legacyTitleAliasMap = new Map();
  const invalidAliasRefs = [];

  for (const entry of aliases) {
    if (entry.specUnitId && entry.rowId) {
      if (!knownUnitIds.has(entry.specUnitId)) {
        invalidAliasRefs.push(entry);
        continue;
      }
      aliasBySpecUnitId.set(entry.specUnitId, entry.rowId);
      continue;
    }

    if (entry.specTitle && entry.checklistTitle) {
      legacyTitleAliasMap.set(normalize(entry.specTitle), entry.checklistTitle);
    }
  }

  const covered = [];
  const missing = [];
  const aliasOnly = [];
  const ambiguous = [];
  const titleFallbacks = [];
  const matchedRowIds = new Set();

  for (const unit of units.primaryUnits) {
    const section = getSectionForSpecUnit(unit);
    if (!section) {
      missing.push({
        unitId: unit.id,
        title: unit.title,
        source: unit.source,
        reason: "unknown-unit-family",
      });
      continue;
    }

    const directRow = checklistIndex.byRowId.get(unit.id);
    if (directRow && directRow.section === section) {
      covered.push(unit);
      matchedRowIds.add(directRow.rowId);
      continue;
    }

    const aliasedRowId = aliasBySpecUnitId.get(unit.id);
    if (aliasedRowId) {
      const aliasedRow = checklistIndex.byRowId.get(aliasedRowId);
      if (aliasedRow && aliasedRow.section === section) {
        covered.push(unit);
        aliasOnly.push({
          unitId: unit.id,
          title: unit.title,
          rowId: aliasedRow.rowId,
          rowTitle: aliasedRow.title,
          reason: "spec-unit-alias",
        });
        matchedRowIds.add(aliasedRow.rowId);
        continue;
      }
    }

    const exactMatches = findRowsByTitle(checklistIndex, unit.title, [section]);
    if (exactMatches.length === 1 && exactMatches[0].rowId) {
      covered.push(unit);
      titleFallbacks.push({
        unitId: unit.id,
        title: unit.title,
        rowId: exactMatches[0].rowId,
        rowTitle: exactMatches[0].title,
        reason: "title-exact-fallback",
      });
      matchedRowIds.add(exactMatches[0].rowId);
      continue;
    }
    if (exactMatches.length > 1) {
      ambiguous.push({
        unitId: unit.id,
        title: unit.title,
        reason: "ambiguous-title-match",
        matches: exactMatches.map((match) => ({
          rowId: match.rowId,
          rowTitle: match.title,
          section: match.section,
        })),
      });
      continue;
    }

    const legacyAliasTitle = legacyTitleAliasMap.get(normalize(unit.title));
    if (legacyAliasTitle) {
      const aliasedMatches = findRowsByTitle(checklistIndex, legacyAliasTitle, [section]);
      if (aliasedMatches.length === 1 && aliasedMatches[0].rowId) {
        covered.push(unit);
        aliasOnly.push({
          unitId: unit.id,
          title: unit.title,
          rowId: aliasedMatches[0].rowId,
          rowTitle: aliasedMatches[0].title,
          reason: "legacy-title-alias",
        });
        matchedRowIds.add(aliasedMatches[0].rowId);
        continue;
      }
      if (aliasedMatches.length > 1) {
        ambiguous.push({
          unitId: unit.id,
          title: unit.title,
          reason: "ambiguous-legacy-title-alias",
          matches: aliasedMatches.map((match) => ({
            rowId: match.rowId,
            rowTitle: match.title,
            section: match.section,
          })),
        });
        continue;
      }
    }

    missing.push({
      unitId: unit.id,
      title: unit.title,
      source: unit.source,
      reason: "missing-row",
    });
  }

  const rowsMissingId = checklistRows
    .filter((row) => !row.rowId)
    .map((row) => ({ section: row.section, title: row.title }));
  const orphanRows = checklistRows
    .filter((row) => row.rowId && !matchedRowIds.has(row.rowId))
    .map((row) => ({
      rowId: row.rowId,
      section: row.section,
      title: row.title,
    }));

  const report = {
    generatedAt: new Date().toISOString(),
    checklist: checklistRepoPath,
    primaryUnitCount: units.primaryUnits.length,
    coveredCount: covered.length,
    missingCount: missing.length,
    aliasOnlyCount: aliasOnly.length,
    titleFallbackCount: titleFallbacks.length,
    ambiguousCount: ambiguous.length,
    orphanCount: orphanRows.length,
    rowsMissingIdCount: rowsMissingId.length,
    invalidAliasRefCount: invalidAliasRefs.length,
    duplicateRowIdCount: checklistIndex.duplicateRowIds.length,
    missing,
    aliasOnly,
    titleFallbacks,
    ambiguous,
    orphanRows,
    rowsMissingId,
    invalidAliasRefs,
    duplicateRowIds: checklistIndex.duplicateRowIds,
  };

  await writeFile(coverageReportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(`Primary units: ${report.primaryUnitCount}`);
  console.log(`Covered: ${report.coveredCount}`);
  console.log(`Missing: ${report.missingCount}`);
  console.log(`Alias only: ${report.aliasOnlyCount}`);
  console.log(`Title fallback: ${report.titleFallbackCount}`);
  console.log(`Ambiguous: ${report.ambiguousCount}`);
  console.log(`Orphan rows: ${report.orphanCount}`);
  console.log(`Rows missing row_id: ${report.rowsMissingIdCount}`);
  console.log(`Invalid alias refs: ${report.invalidAliasRefCount}`);

  if (missing.length > 0) {
    for (const unit of missing) {
      console.log(`MISSING ${unit.title} (${unit.source})`);
    }
  }

  if (ambiguous.length > 0) {
    for (const unit of ambiguous) {
      console.log(`AMBIGUOUS ${unit.title} (${unit.reason})`);
    }
  }

  if (rowsMissingId.length > 0) {
    for (const row of rowsMissingId) {
      console.log(`MISSING_ROW_ID ${row.section} :: ${row.title}`);
    }
  }

  if (invalidAliasRefs.length > 0) {
    for (const entry of invalidAliasRefs) {
      console.log(`INVALID_ALIAS ${entry.specUnitId} -> ${entry.rowId}`);
    }
  }

  if (
    missing.length > 0 ||
    ambiguous.length > 0 ||
    rowsMissingId.length > 0 ||
    invalidAliasRefs.length > 0 ||
    checklistIndex.duplicateRowIds.length > 0
  ) {
    process.exitCode = 1;
  }
}

await main();
