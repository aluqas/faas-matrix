import { readFile, writeFile } from "node:fs/promises";
import { openApiRowMapPath, openApiUnitsPath } from "./paths.mjs";

function groupByFile(operations) {
  const byKey = new Map();
  for (const op of operations) {
    const key = `${op.spec}/${op.file}`;
    const list = byKey.get(key) || [];
    list.push(op);
    byKey.set(key, list);
  }
  return byKey;
}

function toOperationMapping(entry) {
  return {
    rowIds: entry.rowIds || [],
    unitIds: entry.unitIds || [],
  };
}

async function main() {
  const openApiUnits = JSON.parse(await readFile(openApiUnitsPath, "utf8"));
  const openApiRowMap = JSON.parse(await readFile(openApiRowMapPath, "utf8"));

  const fileUnits = openApiUnits.units.filter((u) => u.kind === "file");
  const operationUnits = openApiUnits.units.filter((u) => u.kind === "operation");
  const opsByFile = groupByFile(operationUnits);

  for (const fileUnit of fileUnits) {
    const key = `${fileUnit.spec}/${fileUnit.file}`;
    const entry = openApiRowMap[key];
    if (!entry) continue;

    const operations = opsByFile.get(key) || [];
    entry.operations = entry.operations || {};

    for (const op of operations) {
      const mapping = toOperationMapping(entry);
      if (op.operationId) {
        entry.operations[op.operationId] = mapping;
      }
      // Provide a fallback mapping via operationKey as well.
      entry.operations[op.operationKey] = mapping;
    }
  }

  await writeFile(openApiRowMapPath, `${JSON.stringify(openApiRowMap, null, 2)}\n`, "utf8");
  console.log(`Wrote ${openApiRowMapPath} with operation-level mappings`);
}

await main();

