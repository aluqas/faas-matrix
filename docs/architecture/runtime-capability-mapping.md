# Cloudflare Runtime Capability Mapping

`src/runtime/cloudflare/app-context.ts` maps Cloudflare bindings into the shared capability model.

- `sql`
  - D1 database
- `kv`
  - Sessions, cache, account data, device-key related namespaces
- `blob`
  - R2 media bucket
- `jobs`
  - `executionCtx.waitUntil`
- `workflow`
  - Cloudflare Workflows for room join and push notifications
- `rateLimit`
  - Durable Object namespace
- `realtime`
  - Sync Durable Object wait path
- `metrics`
  - Analytics Engine
- `clock`
  - wall clock wrapper
- `id`
  - Matrix ID / opaque ID generation helpers
- `config`
  - server name, version, and feature profile selection

This keeps Cloudflare-specific code out of the Matrix application layer and establishes the seam for future runtime adapters.
