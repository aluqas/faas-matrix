# Architecture

This repo now has three internal layers.

- `src/foundation/`
  - Runtime-agnostic capabilities, feature profiles, app context, and shared idempotency primitives.
- `src/fedcore/`
  - Federation substrate contracts intended to be reusable by Matrix and future ActivityPub work.
- `src/matrix/`
  - Matrix-specific application services, repository contracts, and event pipeline logic.

Cloudflare-specific bindings now enter through `src/runtime/cloudflare/`, which builds the per-request `AppContext` and service registry.

The first migrated flows are:

- room creation
- room join
- room send
- sync orchestration
- federation transaction ingestion

The external HTTP surface remains unchanged. The main change is that routes now act as transports and delegate to application services.
