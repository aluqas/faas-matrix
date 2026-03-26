import { readFile } from "node:fs/promises";
import { checklistPath, checklistRepoPath } from "./paths.mjs";
import { buildChecklistIndex, extractChecklistRows } from "./checklist-parser.mjs";

function parseTableCells(line) {
  return line.split("|").map((part) => part.trim()).filter(Boolean);
}

function isDividerLine(line) {
  return /^\|\s*[:-]-[-:\s|]+$/.test(line.trim());
}

export async function loadChecklistIndex() {
  const checklist = await readFile(checklistPath, "utf8");
  const rows = extractChecklistRows(checklist);
  return {
    checklistRepoPath,
    rows,
    index: buildChecklistIndex(rows),
  };
}

export function parseComplementEvidenceMarkdown(markdown) {
  const rowsById = new Map();
  let currentSection = null;
  let headerCells = null;

  for (const line of markdown.split("\n")) {
    const headingMatch = line.match(/^###\s+(.+?)\s+—\s+Complement Evidence$/);
    if (headingMatch) {
      currentSection = headingMatch[1].trim();
      headerCells = null;
      continue;
    }

    if (!line.startsWith("|")) {
      headerCells = null;
      continue;
    }

    const cells = parseTableCells(line);
    if (cells.length === 0) continue;

    if (!headerCells) {
      headerCells = cells;
      continue;
    }

    if (isDividerLine(line)) continue;
    if (!currentSection) continue;

    const row = Object.fromEntries(
      headerCells.map((header, index) => [header.trim(), cells[index] || ""]),
    );

    const rowId = row.row_id || "";
    if (!rowId) continue;

    rowsById.set(rowId, {
      section: currentSection,
      title: row.Area || row.Module || "",
      evidence: row.Evidence || "`complement:gap`",
      notes: row.Notes || "",
      surface_status: row.surface_status || "",
      behavior_status: row.behavior_status || "",
      evidence_status: row.evidence_status || "",
    });
  }

  return rowsById;
}
