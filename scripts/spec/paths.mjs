import path from "node:path";

export const repoRoot = process.cwd();
export const specCoverageDir = path.join(repoRoot, "docs", "spec-coverage");
export const matrixDocsDir = path.join(repoRoot, "docs", "matrix");
export const checklistPath = path.join(matrixDocsDir, "speccheck-matrix-v2.md");
export const checklistRepoPath = "docs/matrix/speccheck-matrix-v2.md";

export const matrixSpecUnitsPath = path.join(specCoverageDir, "matrix-spec-units.json");
export const titleAliasesPath = path.join(specCoverageDir, "title-aliases.json");
export const coverageReportPath = path.join(specCoverageDir, "coverage-report.json");
export const openApiUnitsPath = path.join(specCoverageDir, "openapi-units.json");
export const openApiRowMapPath = path.join(specCoverageDir, "openapi-row-map.json");
export const openApiCoverageReportPath = path.join(specCoverageDir, "openapi-coverage-report.json");
