import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const specRoot = path.join(repoRoot, ".saqula", "matrix-spec");
const outputPath = path.join(repoRoot, "docs", "spec-coverage", "matrix-spec-units.json");

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/\{#.*\}/g, "")
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function cleanHeading(value) {
  return value.replace(/\s+\{#.*\}\s*$/, "").trim();
}

async function readLines(filePath) {
  const content = await readFile(filePath, "utf8");
  return content.split("\n");
}

async function extractClientServerCore() {
  const filePath = path.join(specRoot, "content", "client-server-api", "_index.md");
  const lines = await readLines(filePath);
  const units = [];

  for (const line of lines) {
    if (line.startsWith("## Modules")) break;
    const match = line.match(/^##\s+(.+)$/);
    if (!match) continue;
    const title = cleanHeading(match[1]);
    units.push({
      id: `cs-core-${slugify(title)}`,
      title,
      family: "client-server-core",
      level: 2,
      source: "content/client-server-api/_index.md",
      coverageRole: "primary",
    });
  }

  return units;
}

async function extractClientServerModules() {
  const dirPath = path.join(specRoot, "content", "client-server-api", "modules");
  const files = (await readdir(dirPath))
    .filter((entry) => entry.endsWith(".md") && entry !== "index.md")
    .sort();
  const units = [];

  for (const entry of files) {
    const filePath = path.join(dirPath, entry);
    const lines = await readLines(filePath);
    const heading = lines.find((line) => line.startsWith("### "));
    const title = cleanHeading((heading || entry).replace(/^###\s+/, "").replace(/\.md$/, ""));
    units.push({
      id: `cs-module-${slugify(title)}`,
      title,
      family: "client-server-module",
      level: 3,
      source: `content/client-server-api/modules/${entry}`,
      coverageRole: "primary",
    });
  }

  return units;
}

async function extractServerServerUnits() {
  const filePath = path.join(specRoot, "content", "server-server-api.md");
  const lines = await readLines(filePath);
  const units = [];
  let currentH2 = null;

  const h3Allowlist = new Set([
    "TLS",
    "Unsupported endpoints",
    "Request Authentication",
    "Response Authentication",
    "Client TLS Certificates",
  ]);

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+)$/);
    if (h2) {
      currentH2 = cleanHeading(h2[1]);
      units.push({
        id: `ss-core-${slugify(currentH2)}`,
        title: currentH2,
        family: "server-server-core",
        level: 2,
        source: "content/server-server-api.md",
        coverageRole: "primary",
      });
      continue;
    }

    const h3 = line.match(/^###\s+(.+)$/);
    if (!h3) continue;
    const title = cleanHeading(h3[1]);
    if (!h3Allowlist.has(title)) continue;
    units.push({
      id: `ss-subsection-${slugify(currentH2 || "unknown")}-${slugify(title)}`,
      title,
      parent: currentH2,
      family: "server-server-subsection",
      level: 3,
      source: "content/server-server-api.md",
      coverageRole: "primary",
    });
  }

  return units;
}

async function extractOpenApiInventory(specName) {
  const dirPath = path.join(specRoot, "data", "api", specName);
  const files = (await readdir(dirPath)).filter((entry) => entry.endsWith(".yaml")).sort();
  return files.map((entry) => ({
    id: `${specName}-${entry.replace(/\.yaml$/, "")}`,
    title: entry.replace(/\.yaml$/, ""),
    family: `${specName}-openapi`,
    source: `data/api/${specName}/${entry}`,
    coverageRole: "supplemental",
  }));
}

async function main() {
  const clientServerCore = await extractClientServerCore();
  const clientServerModules = await extractClientServerModules();
  const serverServerUnits = await extractServerServerUnits();
  const clientServerOpenApi = await extractOpenApiInventory("client-server");
  const serverServerOpenApi = await extractOpenApiInventory("server-server");

  const payload = {
    generatedAt: new Date().toISOString(),
    specRoot: ".saqula/matrix-spec",
    coverageModel: {
      primary: "Markdown section/module units",
      supplemental: "OpenAPI inventory",
      evidence: "Complement and local interop runs",
    },
    primaryUnits: [
      ...clientServerCore,
      ...clientServerModules,
      ...serverServerUnits,
    ],
    supplementalUnits: [
      ...clientServerOpenApi,
      ...serverServerOpenApi,
    ],
    evidenceSources: [
      {
        id: "complement",
        title: "matrix-org/complement",
        source: "https://github.com/matrix-org/complement",
        role: "black-box integration evidence",
      },
    ],
  };

  await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  console.log(`Wrote ${path.relative(repoRoot, outputPath)}`);
  console.log(`Primary units: ${payload.primaryUnits.length}`);
  console.log(`Supplemental units: ${payload.supplementalUnits.length}`);
}

await main();
