# fatrix-backend/application

`application` owns Matrix use-cases, orchestration policy, projectors, and port
interfaces. It should not own Cloudflare bindings or concrete repositories.

## Feature Shape

New and actively refactored features should use this shape:

- `commands/` or `command.ts`: write-side use-cases.
- `queries/` or `query.ts`: read-side use-cases.
- `projectors/` or `project.ts`: pure response/event projection.
- `policies/` or `policy.ts`: domain decisions with no concrete IO.
- `ports.ts` or feature-local port interfaces: IO boundaries consumed by use-cases.
- `types.ts`: feature-owned records and DTOs that should not be imported from adapters.

HTTP request decode belongs in `src/fatrix-api/decoders`. Cloudflare concrete
port factories belong in `src/platform/cloudflare/adapters/application-ports`.

## Federation

Server-server use-cases live under `application/federation`:

- `transactions/`
- `events/`
- `membership/`
- `query/`
- `e2ee/`

Federation-specific port interfaces are collected in `application/federation/ports.ts`.

## Boundary Debt

`scripts/check-layer-boundaries.mjs` freezes the remaining
`application -> platform/cloudflare` import baseline. New application files must
not add platform imports. Existing baseline files should be reduced as their
logic is moved behind ports and facade use-cases.
