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
- `complement-map.json`
  - Maps rows in `docs/matrix/speccheck-matrix-v2.md` to Complement test files which can serve as black-box evidence.
- `title-aliases.json`
  - Normalization map from spec titles to checklist row titles when the names differ.
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

## Limits

This mechanism proves checklist completeness at the chosen granularity.
It does not prove that the implementation is correct.

For that, use:

- unit and integration tests
- Complement
- client interoperability runs
- federation interoperability runs
