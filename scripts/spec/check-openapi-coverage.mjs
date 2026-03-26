import { readFile, writeFile } from "node:fs/promises";
import {
  checklistPath,
  checklistRepoPath,
  matrixSpecUnitsPath,
  openApiCoverageReportPath,
  openApiRowMapPath,
  openApiUnitsPath,
} from "./paths.mjs";
import {
  buildChecklistIndex,
  extractChecklistRows,
  getAllowedSectionsForOpenApiSpec,
  resolveLegacyRows,
} from "./checklist-parser.mjs";

async function main() {
  const units = JSON.parse(await readFile(openApiUnitsPath, "utf8"));
  const matrixUnits = JSON.parse(await readFile(matrixSpecUnitsPath, "utf8"));
  const coverageMap = JSON.parse(await readFile(openApiRowMapPath, "utf8"));
  const checklist = await readFile(checklistPath, "utf8");

  const checklistRows = extractChecklistRows(checklist);
  const checklistIndex = buildChecklistIndex(checklistRows);
  const primaryUnitIds = new Set(matrixUnits.primaryUnits.map((unit) => unit.id));
  const fileUnits = units.units.filter((unit) => unit.kind === "file");
  const operationUnits = units.units.filter((unit) => unit.kind === "operation");
  const operationsByFile = new Map();

  for (const operation of operationUnits) {
    const key = `${operation.spec}/${operation.file}`;
    const matches = operationsByFile.get(key) || [];
    matches.push(operation);
    operationsByFile.set(key, matches);
  }

  const missing = [];
  const invalidRows = [];
  const ambiguousRows = [];
  const invalidRowIds = [];
  const invalidUnitRefs = [];
  const legacyRowMappings = [];
  const unmappedOperations = [];
  const covered = [];

  for (const unit of fileUnits) {
    const key = `${unit.spec}/${unit.file}`;
    const mapping = coverageMap[key];
    if (!mapping) {
      missing.push({ key, reason: "missing-map-entry" });
      continue;
    }

    const allowedSections = getAllowedSectionsForOpenApiSpec(unit.spec);
    const explicitRowIds = mapping.rowIds || [];
    const resolvedLegacyRows = resolveLegacyRows(checklistIndex, mapping.rows || [], allowedSections);
    const resolvedRowIds = [...new Set([...explicitRowIds, ...resolvedLegacyRows.resolvedRowIds])];
    const unitIds = [...new Set(mapping.unitIds || [])];
    const operationMappings = mapping.operations || {};

    if ((mapping.rowIds || []).length === 0 && mapping.rows?.length > 0) {
      legacyRowMappings.push({
        key,
        rows: mapping.rows,
        resolvedRowIds: resolvedLegacyRows.resolvedRowIds,
      });
    }

    if (resolvedLegacyRows.unresolvedRows.length > 0) {
      invalidRows.push({ key, rows: resolvedLegacyRows.unresolvedRows });
      continue;
    }

    if (resolvedLegacyRows.ambiguousRows.length > 0) {
      ambiguousRows.push({ key, rows: resolvedLegacyRows.ambiguousRows });
      continue;
    }

    if (resolvedRowIds.length === 0 && mapping.scope !== "out-of-scope") {
      missing.push({ key, reason: "empty-row-refs" });
      continue;
    }

    const unresolvedRowIds = resolvedRowIds.filter((rowId) => !checklistIndex.byRowId.has(rowId));
    if (unresolvedRowIds.length > 0) {
      invalidRowIds.push({ key, rowIds: unresolvedRowIds });
      continue;
    }

    const unknownUnitIds = unitIds.filter((unitId) => !primaryUnitIds.has(unitId));
    if (unknownUnitIds.length > 0) {
      invalidUnitRefs.push({ key, unitIds: unknownUnitIds });
      continue;
    }

    const fileOperations = operationsByFile.get(key) || [];
    const mappedOperations = [];

    for (const operation of fileOperations) {
      const operationMapping =
        operationMappings[operation.operationId] ||
        operationMappings[operation.operationKey] ||
        null;

      if (!operationMapping) {
        unmappedOperations.push({
          key,
          operationId: operation.operationId,
          operationKey: operation.operationKey,
          method: operation.method,
          path: operation.path,
        });
        continue;
      }

      const operationRowIds = [...new Set([
        ...(operationMapping.rowIds || []),
        ...(operationMapping.rowId ? [operationMapping.rowId] : []),
      ])];
      const operationUnitIds = [...new Set([
        ...(operationMapping.unitIds || []),
        ...(operationMapping.unitId ? [operationMapping.unitId] : []),
      ])];

      const unexpectedOperationRowIds = operationRowIds.filter((rowId) => !resolvedRowIds.includes(rowId));
      if (unexpectedOperationRowIds.length > 0) {
        invalidRowIds.push({
          key,
          operationId: operation.operationId,
          rowIds: unexpectedOperationRowIds,
          reason: "operation-rowid-outside-file-rowids",
        });
        continue;
      }

      const unexpectedOperationUnitIds = operationUnitIds.filter((unitId) => !unitIds.includes(unitId));
      if (unexpectedOperationUnitIds.length > 0) {
        invalidUnitRefs.push({
          key,
          operationId: operation.operationId,
          unitIds: unexpectedOperationUnitIds,
          reason: "operation-unitid-outside-file-unitids",
        });
        continue;
      }

      const invalidOperationRowIds = operationRowIds.filter((rowId) => !checklistIndex.byRowId.has(rowId));
      if (invalidOperationRowIds.length > 0) {
        invalidRowIds.push({
          key,
          operationId: operation.operationId,
          rowIds: invalidOperationRowIds,
        });
        continue;
      }

      const invalidOperationUnitIds = operationUnitIds.filter((unitId) => !primaryUnitIds.has(unitId));
      if (invalidOperationUnitIds.length > 0) {
        invalidUnitRefs.push({
          key,
          operationId: operation.operationId,
          unitIds: invalidOperationUnitIds,
        });
        continue;
      }

      mappedOperations.push({
        operationId: operation.operationId,
        operationKey: operation.operationKey,
        rowIds: operationRowIds,
        unitIds: operationUnitIds,
      });
    }

    covered.push({
      key,
      scope: mapping.scope || "tracked",
      rowIds: resolvedRowIds,
      unitIds,
      rows: mapping.rows || [],
      operationCount: fileOperations.length,
      mappedOperationCount: mappedOperations.length,
      operations: mappedOperations,
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    checklist: checklistRepoPath,
    openApiFileCount: fileUnits.length,
    coveredCount: covered.length,
    missingCount: missing.length,
    invalidRowCount: invalidRows.length,
    ambiguousRowCount: ambiguousRows.length,
    invalidRowIdCount: invalidRowIds.length,
    invalidUnitRefCount: invalidUnitRefs.length,
    legacyRowMappingCount: legacyRowMappings.length,
    unmappedOperationCount: unmappedOperations.length,
    missing,
    invalidRows,
    ambiguousRows,
    invalidRowIds,
    invalidUnitRefs,
    legacyRowMappings,
    unmappedOperations,
    covered,
  };

  await writeFile(openApiCoverageReportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(`OpenAPI files: ${report.openApiFileCount}`);
  console.log(`Covered: ${report.coveredCount}`);
  console.log(`Missing map entries: ${report.missingCount}`);
  console.log(`Invalid checklist rows: ${report.invalidRowCount}`);
  console.log(`Ambiguous checklist rows: ${report.ambiguousRowCount}`);
  console.log(`Invalid row IDs: ${report.invalidRowIdCount}`);
  console.log(`Invalid unit refs: ${report.invalidUnitRefCount}`);
  console.log(`Legacy title mappings: ${report.legacyRowMappingCount}`);
  console.log(`Unmapped operations: ${report.unmappedOperationCount}`);

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

  if (ambiguousRows.length > 0) {
    for (const item of ambiguousRows) {
      console.log(`AMBIGUOUS ${item.key}`);
    }
  }

  if (invalidRowIds.length > 0) {
    for (const item of invalidRowIds) {
      console.log(`INVALID_ROW_ID ${item.key} -> ${item.rowIds.join(", ")}`);
    }
  }

  if (invalidUnitRefs.length > 0) {
    for (const item of invalidUnitRefs) {
      console.log(`INVALID_UNIT_REF ${item.key} -> ${item.unitIds.join(", ")}`);
    }
  }

  if (
    missing.length > 0 ||
    invalidRows.length > 0 ||
    ambiguousRows.length > 0 ||
    invalidRowIds.length > 0 ||
    invalidUnitRefs.length > 0 ||
    checklistIndex.duplicateRowIds.length > 0
  ) {
    process.exitCode = 1;
  }
}

await main();
