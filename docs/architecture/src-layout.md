# Src Layout

The source tree is intentionally shallow and organized around six top-level pillars:

- `src/api`
  - Route homes and endpoint registration.
  - Handlers should stay thin: read inputs, decode, call use-cases, shape responses.
- `src/features`
  - Feature-level application code.
  - This is the main home for endpoint-oriented use-cases and feature-local helpers.
- `src/infra`
  - Database, repositories, middleware, integrations, federation transport, and realtime infrastructure.
- `src/platform`
  - Cloudflare-specific execution code such as Durable Objects, workflows, consumers, and platform wiring.
- `src/shared`
  - Low-level shared types, utilities, runtime/context primitives, and Effect helpers.
- `src/matrix`
  - Matrix-specific domain and cross-feature application core.
  - This includes:
    - `domain/`
    - `application/orchestrators/`
    - `application/runtime/`
    - `application/legacy/`
    - flat cross-feature application helpers such as room/federation validation, logging, and transition/query support.

`src/matrix` is not a general catch-all. New code should go to `features`, `infra`, `platform`, or `shared` unless it is clearly Matrix-specific app-core or domain code.

