import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { openApiUnitsPath, repoRoot } from "./paths.mjs";

const specRoot = path.join(repoRoot, ".saqula", "matrix-spec", "data", "api");

function normalizePathKey(rawPath) {
  return rawPath.replaceAll(/^["']|["']$/g, "");
}

function leadingSpaces(line) {
  const match = line.match(/^ */);
  return match ? match[0].length : 0;
}

function slugifyPath(value) {
  return value
    .toLowerCase()
    .replaceAll(/[{}]/g, "")
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
}

async function extractSpec(specName) {
  const dirPath = path.join(specRoot, specName);
  const files = (await readdir(dirPath)).filter((entry) => entry.endsWith(".yaml")).toSorted();
  const specUnits = [];

  for (const entry of files) {
    const source = `data/api/${specName}/${entry}`;
    const filePath = path.join(dirPath, entry);
    const content = await readFile(filePath, "utf8");
    const lines = content.split("\n");

    const fileUnit = {
      id: `${specName}-${entry.replace(/\.yaml$/, "")}`,
      kind: "file",
      spec: specName,
      source,
      file: entry,
      title: entry.replace(/\.yaml$/, ""),
    };
    specUnits.push(fileUnit);

    let inPaths = false;
    let currentPath = null;
    let currentMethod = null;
    let currentOperationId = null;

    const flushOperation = () => {
      if (!currentPath || !currentMethod) return;
      const operationKey = `${currentMethod.toUpperCase()} ${currentPath}`;
      specUnits.push({
        id: `${specName}-${entry.replace(/\.yaml$/, "")}-${currentMethod}-${slugifyPath(currentPath)}`,
        kind: "operation",
        spec: specName,
        source,
        file: entry,
        path: currentPath,
        method: currentMethod,
        operationId: currentOperationId,
        operationKey,
        title: currentOperationId || operationKey,
      });
    };

    for (const line of lines) {
      if (!inPaths) {
        if (line.trim() === "paths:") inPaths = true;
        continue;
      }

      const indent = leadingSpaces(line);
      const trimmed = line.trim();

      if (indent === 2 && trimmed.endsWith(":")) {
        flushOperation();
        currentPath = normalizePathKey(trimmed.slice(0, -1));
        currentMethod = null;
        currentOperationId = null;
        continue;
      }

      const methodMatch =
        indent === 4 ? trimmed.match(/^(get|post|put|delete|patch|head|options):$/) : null;
      if (methodMatch) {
        flushOperation();
        currentMethod = methodMatch[1];
        currentOperationId = null;
        continue;
      }

      const operationMatch = indent === 6 ? trimmed.match(/^operationId:\s*(.+)\s*$/) : null;
      if (operationMatch) {
        currentOperationId = operationMatch[1].trim();
        continue;
      }

      if (indent === 0 && (trimmed === "servers:" || trimmed === "components:")) {
        break;
      }
    }

    flushOperation();
  }

  return specUnits;
}

async function main() {
  const clientServer = await extractSpec("client-server");
  const serverServer = await extractSpec("server-server");
  const payload = {
    generatedAt: new Date().toISOString(),
    sourceRoot: ".saqula/matrix-spec/data/api",
    units: [...clientServer, ...serverServer],
  };

  await writeFile(openApiUnitsPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  const fileCount = payload.units.filter((unit) => unit.kind === "file").length;
  const operationCount = payload.units.filter((unit) => unit.kind === "operation").length;
  console.log(`Wrote ${path.relative(repoRoot, openApiUnitsPath)}`);
  console.log(`Files: ${fileCount}`);
  console.log(`Operations: ${operationCount}`);
}

await main();
