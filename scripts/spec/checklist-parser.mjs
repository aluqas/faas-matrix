const TARGET_SECTIONS = Object.freeze([
  "Client-Server Core",
  "Client-Server Modules",
  "Server-Server Core",
]);

const SECTION_BY_FAMILY = {
  "client-server-core": "Client-Server Core",
  "client-server-module": "Client-Server Modules",
  "server-server-core": "Server-Server Core",
  "server-server-subsection": "Server-Server Core",
};

export function normalize(value = "") {
  return value
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function isDividerLine(line) {
  return /^\|\s*[:-]-[-:\s|]+$/.test(line.trim());
}

function parseTableCells(line) {
  return line
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeHeader(header) {
  return normalize(header).replace(/\s+/g, "_");
}

function stripCodeTicks(value = "") {
  return value.replace(/^`|`$/g, "").trim();
}

function rowTitleFromCells(cells) {
  return cells.area || cells.module || cells[0] || "";
}

export function extractChecklistRows(markdown) {
  const rows = [];
  let currentSection = null;
  let headerCells = null;

  for (const line of markdown.split("\n")) {
    const headingMatch = line.match(/^##\s+(.+)$/);
    if (headingMatch) {
      currentSection = headingMatch[1].trim();
      headerCells = null;
      continue;
    }

    if (!line.startsWith("|")) {
      headerCells = null;
      continue;
    }

    if (!TARGET_SECTIONS.includes(currentSection)) continue;

    const cells = parseTableCells(line);
    if (cells.length === 0) continue;

    if (!headerCells) {
      headerCells = cells.map(normalizeHeader);
      continue;
    }

    if (isDividerLine(line)) continue;

    const cellMap = Object.fromEntries(
      headerCells.map((header, index) => [header, cells[index] || ""]),
    );
    const title = rowTitleFromCells(cellMap);

    rows.push({
      section: currentSection,
      title,
      rowId: stripCodeTicks(cellMap.row_id || ""),
      cells: cellMap,
    });
  }

  return rows;
}

export function buildChecklistIndex(rows) {
  const byRowId = new Map();
  const bySectionAndTitle = new Map();
  const duplicateRowIds = [];

  for (const row of rows) {
    if (row.rowId) {
      if (byRowId.has(row.rowId)) {
        duplicateRowIds.push({
          rowId: row.rowId,
          titles: [byRowId.get(row.rowId).title, row.title],
        });
      } else {
        byRowId.set(row.rowId, row);
      }
    }

    const key = `${row.section}::${normalize(row.title)}`;
    const matches = bySectionAndTitle.get(key) || [];
    matches.push(row);
    bySectionAndTitle.set(key, matches);
  }

  return {
    rows,
    byRowId,
    bySectionAndTitle,
    duplicateRowIds,
  };
}

export function getSectionForSpecUnit(unit) {
  return SECTION_BY_FAMILY[unit.family] || null;
}

export function getAllowedSectionsForOpenApiSpec(spec) {
  if (spec === "client-server") {
    return ["Client-Server Core", "Client-Server Modules"];
  }
  if (spec === "server-server") {
    return ["Server-Server Core"];
  }
  return [...TARGET_SECTIONS];
}

export function findRowsByTitle(index, title, allowedSections = TARGET_SECTIONS) {
  const normalizedTitle = normalize(title);
  const matches = [];

  for (const section of allowedSections) {
    const key = `${section}::${normalizedTitle}`;
    const sectionMatches = index.bySectionAndTitle.get(key) || [];
    matches.push(...sectionMatches);
  }

  return matches;
}

export function resolveLegacyRows(index, rows, allowedSections) {
  const resolvedRowIds = [];
  const unresolvedRows = [];
  const ambiguousRows = [];

  for (const rowTitle of rows || []) {
    const matches = findRowsByTitle(index, rowTitle, allowedSections);
    if (matches.length === 0) {
      unresolvedRows.push(rowTitle);
      continue;
    }
    if (matches.length > 1) {
      ambiguousRows.push({
        row: rowTitle,
        matches: matches.map((candidate) => ({
          rowId: candidate.rowId,
          title: candidate.title,
          section: candidate.section,
        })),
      });
      continue;
    }
    if (matches[0].rowId) {
      resolvedRowIds.push(matches[0].rowId);
    }
  }

  return {
    resolvedRowIds,
    unresolvedRows,
    ambiguousRows,
  };
}
