# Spec Coverage

This directory contains the machinery for checking that our Matrix checklist covers the specification surface in a systematic way.

## Model

There are three separate inputs:

1. Markdown spec structure
   - Primary coverage source.
   - Extracted from the local `matrix-spec` clone under `.saqula/matrix-spec/content/`.
   - Used to answer: "Did we enumerate the spec sections and modules?"
2. OpenAPI files
   - Primary endpoint inventory.
   - Extracted from `.saqula/matrix-spec/data/api/`.
   - Used to answer: "Did we explicitly account for the endpoint surface exposed by the spec?"
3. Complement
   - Evidence source.
   - Used to answer: "Do we have black-box interoperability evidence for what we claim?"

This split is deliberate:

- Markdown gives the chapter/module structure we want as a coarse completeness floor.
- OpenAPI gives the endpoint-level coverage backbone.
- Complement gives implementation evidence, not checklist completeness.

## Files

- `matrix-spec-units.json`
  - Generated inventory of primary and supplemental spec units.
- `openapi-units.json`
  - Generated OpenAPI file and operation inventory.
- `openapi-row-map.json`
  - Maps OpenAPI files to rows in `docs/matrix/speccheck-matrix-v2.md`.
  - `rowIds` is the stable machine-readable link to checklist rows.
  - Legacy `rows` titles may remain during migration, but should not be the long-term source of truth.
- `complement-map.json`
  - Maps rows in `docs/matrix/speccheck-matrix-v2.md` to Complement test files which can serve as black-box evidence.
- `title-aliases.json`
  - Transitional map from spec unit IDs to checklist `row_id` values for cases where one checklist row intentionally collapses multiple spec units.
- `coverage-report.json`
  - Generated output from the coverage check.
- `openapi-coverage-report.json`
  - Generated output from the OpenAPI coverage check.

`complement-map.json` is intentionally manual.
Unlike Markdown and OpenAPI extraction, Complement evidence mapping requires judgment about what a given test actually proves.

## Commands

```bash
bun run spec:extract
bun run spec:coverage
bun run spec:extract:openapi
bun run spec:coverage:openapi
```

`spec:extract` refreshes both the Markdown-derived and OpenAPI-derived inventories from the local spec clone.

`spec:coverage` runs both the Markdown structure coverage check and the OpenAPI coverage check.

`spec:coverage:openapi` checks whether every OpenAPI file is explicitly accounted for in `docs/matrix/speccheck-matrix-v2.md` through `openapi-row-map.json`.

## Checklist Contract

Coverage automation reads only these sections in `docs/matrix/speccheck-matrix-v2.md`:

- `Client-Server Core`
- `Client-Server Modules`
- `Server-Server Core`

The following sections are intentionally excluded from coverage target extraction:

- `Cross-Cutting Evidence Rows`
- `Complement Evidence Summary`

Within the primary sections:

- `row_id` is the stable checklist key.
- Row labels are allowed to change as long as `row_id` remains stable.
- Rows without a matching Markdown spec unit may still exist, but they will be reported as `orphanRows`.
- OpenAPI operation-level mappings are optional during migration; missing ones are reported as `unmappedOperations`.

## Limits

This mechanism proves checklist completeness at the chosen granularity.
It does not prove that the implementation is correct.

For that, use:

- unit and integration tests
- Complement
- client interoperability runs
- federation interoperability runs
