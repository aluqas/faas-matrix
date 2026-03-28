import { readFile } from "node:fs/promises";
import path from "node:path";
import { matrixDocsDir, specCoverageDir } from "./paths.mjs";
import { normalize } from "./checklist-parser.mjs";
import { loadChecklistIndex, parseComplementEvidenceMarkdown } from "./complement-parser.mjs";

export const complementMapPath = path.join(specCoverageDir, "complement-map.json");
const complementDocPath = path.join(matrixDocsDir, "speccheck-matrix-v2-complement.md");

export async function loadComplementMap() {
  const raw = JSON.parse(await readFile(complementMapPath, "utf8"));
  if (raw.rowsById) return raw;

  const { rows } = await loadChecklistIndex();
  const complementDoc = await readFile(complementDocPath, "utf8");
  const summaryByRowId = parseComplementEvidenceMarkdown(complementDoc);
  const legacyRows = raw.rows || {};
  const exactLegacy = new Map(Object.entries(legacyRows));
  const normalizedLegacy = new Map(
    Object.entries(legacyRows).map(([title, entry]) => [normalize(title), entry]),
  );

  const rowsById = {};
  for (const row of rows) {
    const summary = summaryByRowId.get(row.rowId);
    const legacy = exactLegacy.get(row.title) || normalizedLegacy.get(normalize(row.title)) || null;
    rowsById[row.rowId] = {
      section: row.section,
      title: row.title,
      evidence: summary?.evidence || "`complement:gap`",
      notes: summary?.notes || "Not explicitly covered in complement-analysis.md test runs.",
      surface_status: summary?.surface_status || row.cells.surface_status,
      behavior_status: summary?.behavior_status || row.cells.behavior_status,
      evidence_status: summary?.evidence_status || row.cells.evidence_status,
      mappingStatus: legacy?.status || "planned",
      tests: legacy?.tests || [],
    };
  }

  return {
    ...raw,
    rowsById,
    legacyRows: raw.rows || {},
  };
}
