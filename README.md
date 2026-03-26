# faas-matrix

Matrix homeserver implementation for Cloudflare Workers, now being refactored toward a thinner FaaS-native core.

## What This Repo Is

This repository contains the current Matrix implementation plus the new internal split into:

- `src/foundation/` for shared substrate and runtime-agnostic contracts
- `src/fedcore/` for federation substrate
- `src/matrix/` for Matrix-specific application logic
- `src/runtime/cloudflare/` for Cloudflare bindings and adapters

The goal of the current phase is architectural separation, not feature removal.

## Docs

- [Architecture](./docs/architecture.md)
- [Event Pipeline](./docs/event-pipeline.md)
- [Feature Profiles](./docs/feature-profiles.md)
- [Runtime Capability Mapping](./docs/runtime-capability-mapping.md)
- [Matrix Spec Checklist](./docs/speccheck-matrix.md)

## Development

```bash
bun install
bun run dev
bun run typecheck
bun run lint
bun run test
```

The project now uses `bun` for package management and `oxlint` / `oxfmt` for linting and formatting.

## License

MIT. See [LICENSE](./LICENSE).

## Credits

This project is based on work from:

- [nkuntz1934/matrix-workers](https://github.com/nkuntz1934/matrix-workers)
- [Serverless Matrix Homeserver on Cloudflare Workers](https://blog.cloudflare.com/serverless-matrix-homeserver-workers/)
