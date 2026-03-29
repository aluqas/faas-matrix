import { readFile, writeFile } from "node:fs/promises";
import { extractChecklistRows } from "./checklist-parser.mjs";
import { loadComplementMap } from "./load-complement-map.mjs";

const v2Path = new URL("../../docs/matrix/speccheck-matrix-v2.md", import.meta.url).pathname;
const complementPath = new URL(
  "../../docs/matrix/speccheck-matrix-v2-complement.md",
  import.meta.url,
).pathname;

function getBlock(content, heading) {
  const start = content.indexOf(heading);
  if (start === -1) throw new Error(`Missing heading: ${heading}`);
  const startLineEnd = content.indexOf("\n", start);
  const afterHeading = startLineEnd === -1 ? content.length : startLineEnd + 1;
  return { start, afterHeading };
}

function replaceBetweenHeadings(content, heading, nextHeading, replacement) {
  const { afterHeading } = getBlock(content, heading);
  const nextStart = content.indexOf(nextHeading);
  if (nextStart === -1) throw new Error(`Missing next heading: ${nextHeading}`);
  return content.slice(0, afterHeading) + replacement + content.slice(nextStart);
}

function renderComplementTable(sectionRows, firstColumnHeader) {
  const header = `| ${firstColumnHeader} | Evidence | Notes | surface_status | behavior_status | evidence_status | row_id |`;
  const divider = `|------|----------|-------|----------------|-----------------|-----------------|--------|`;
  const lines = [header, divider];

  for (const row of sectionRows) {
    const areaCell = row.title;
    const evidence = row.evidenceRow?.evidence ?? "`complement:gap`";
    const notes =
      row.evidenceRow?.notes ?? "Not explicitly covered in complement-analysis.md test runs.";
    const surface_status = row.evidenceRow?.surface_status ?? row.surface_status;
    const behavior_status = row.evidenceRow?.behavior_status ?? row.behavior_status;
    const evidence_status = row.evidenceRow?.evidence_status ?? row.evidence_status;

    lines.push(
      `| ${areaCell} | ${evidence} | ${notes} | ${surface_status} | ${behavior_status} | ${evidence_status} | ${row.rowId} |`,
    );
  }

  return "\n" + lines.join("\n") + "\n\n";
}

async function main() {
  const v2 = await readFile(v2Path, "utf8");
  const complementMap = await loadComplementMap();
  let complement = null;
  try {
    complement = await readFile(complementPath, "utf8");
  } catch {
    // complement doc may not exist yet; fall back to v2 content for output.
    complement = v2;
  }

  const checklistRows = extractChecklistRows(v2);
  const bySection = {
    "Client-Server Core": [],
    "Client-Server Modules": [],
    "Server-Server Core": [],
  };

  for (const row of checklistRows) {
    if (!bySection[row.section]) continue;
    bySection[row.section].push(row);
  }

  // Parse existing complement evidence tables to keep current evidence/notes where possible.
  const coreHeading = "### Client-Server Core — Complement Evidence";
  const modulesHeading = "### Client-Server Modules — Complement Evidence";
  const serverHeading = "### Server-Server Core — Complement Evidence";

  const rendered = {
    "Client-Server Core": null,
    "Client-Server Modules": null,
    "Server-Server Core": null,
  };

  for (const [sectionName, rows] of Object.entries(bySection)) {
    const firstColumnHeader = sectionName === "Client-Server Modules" ? "Module" : "Area";

    const sectionRows = rows.map((row) => {
      return {
        title: row.title,
        rowId: row.rowId,
        surface_status: row.cells.surface_status,
        behavior_status: row.cells.behavior_status,
        evidence_status: row.cells.evidence_status,
        evidenceRow: complementMap.rowsById?.[row.rowId] || null,
      };
    });

    rendered[sectionName] = renderComplementTable(sectionRows, firstColumnHeader);
  }

  let out = complement;
  out = replaceBetweenHeadings(out, coreHeading, modulesHeading, rendered["Client-Server Core"]);
  out = replaceBetweenHeadings(
    out,
    modulesHeading,
    serverHeading,
    rendered["Client-Server Modules"],
  );

  // Replace server core table until the next top-level section, or EOF.
  const { afterHeading: serverAfter } = getBlock(out, serverHeading);
  const nextSectionIndex = out.indexOf("\n## ", serverAfter);
  const serverEnd = nextSectionIndex === -1 ? out.length : nextSectionIndex;
  out = out.slice(0, serverAfter) + rendered["Server-Server Core"] + out.slice(serverEnd);

  await writeFile(complementPath, out, "utf8");
  console.log("Updated Complement Evidence Summary tables in speccheck-matrix-v2-complement.md");
}

await main();
