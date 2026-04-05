# AGENTS.md

This file provides guidance to coding agents when working with code in this repository.

## Project Overview

Tuwunel is a Matrix homeserver (spec v1.17) running entirely on Cloudflare Workers edge infrastructure. It uses D1 (SQLite), KV, R2, Durable Objects, and Workflows. The live instance runs at `m.easydemo.org`.

- Effect: 複雑なValidationやエラー、依存注入など、Effect + Honoを中心にコードベースを破壊的にリファクタリング中
  - コードベース全体のBigbangは行わず、TDD時にredを起点にリアーキテクチャしている。
- 今後書くSQLクエリはすべてkyselyを使用してください。

- リアーキテクチャ・リファクタリング方針
  - `api/*`はendpointの所在を示し、`app.get`や`app.post`はendpointごとに残す。
    - そのほうがendpointの所在を構造的に決定的に示せ、かつ参照点が明確になるため。
    - であるため、これについては今後いかなるリアーキテクチャ、リファクタリングを進めるとしても死守する。
  - そのためやるべきことは以下の点
    - 内部ロジックの抽象化をとにかく洗練、積み上げること
      - Effect use-case
      - validation
      - schema
      - DTO / type
      - error
      - sharedなprojector, encoder
    - 残すのは
      - `app.get`や`app.post`の存在そのもの（もちろん）
      - path, query, body, headerの読み取り
      - decode呼び出し
      - use-case呼び出し
      - response変換

- 基本方針
  - 命名のスタイルを統一し
  - 統廃合を行い
  - 拡張性・応用の観点からの抽象化の細分化を行い、境界を明確化し
  - まとめたspecに合わせた型設計を行う（specに従ってなければ自然と型エラー吐くように）

## Development Commands

```bash
bun run dev              # Local dev server (wrangler dev)
bun run deploy           # Deploy to Cloudflare
bun run spec:extract     # Refresh Markdown and OpenAPI spec coverage inventories from local matrix-spec clone
bun run spec:coverage    # Run Markdown and OpenAPI coverage checks against docs/matrix/speccheck-matrix-v2.md
bun run typecheck        # TypeScript type checking (tsc --noEmit)
bun run lint             # oxlint on src/
bun run test             # Vitest
bun run db:migrate       # Run D1 migrations (remote)
bun run db:migrate:local # Run D1 migrations (local)
```

## Architecture

**Framework:** Hono web framework with typed `AppEnv` bindings for Cloudflare resources.

**Entry point:** `src/index.ts` — creates the Hono app, applies global middleware (CORS → Logger → Rate Limit), mounts all route modules, and exports Durable Objects + Workflows.

**Layered structure:**

- `src/api/` — Route handlers (30+ modules). Each exports a Hono instance mounted in the main app. Largest: `federation.ts` (103KB), `sliding-sync.ts` (81KB), `admin.ts` (80KB), `rooms.ts` (73KB).
- `src/middleware/` — Auth (`requireAuth()`), rate limiting (DO-based sliding window), federation auth (Ed25519 X-Matrix), idempotency.
- `src/services/` — Business logic: `database.ts` (D1 queries, no ORM), `federation-keys.ts`, `server-discovery.ts`, `email.ts` (Cloudflare Email Service), `oidc.ts`, `turn.ts`, `livekit.ts`, `cloudflare-calls.ts`, `room-cache.ts`, `transactions.ts`.
- `src/durable-objects/` — 8 DOs: Room (WebSocket coordination), Sync, Federation (queue), CallRoom (video), Admin, UserKeys (E2EE), Push, RateLimit.
- `src/workflows/` — `RoomJoinWorkflow` (federation handshake with retry), `PushNotificationWorkflow`.
- `src/types/` — `env.ts` (Cloudflare bindings), `matrix.ts` (PDU/event types).
- `src/utils/` — `crypto.ts` (hashing/signing), `ids.ts` (Matrix ID generation), `errors.ts` (MatrixApiError + Errors factory).
- `src/admin/dashboard.ts` — Embedded admin web UI at `/admin`.
- `migrations/` — D1 schema files (schema.sql + numbered migrations 002–011).

**Storage bindings (defined in `wrangler.jsonc`):**

- D1 `tuwunel-db` — Relational data (users, rooms, events, memberships, etc.)
- KV namespaces: `SESSIONS`, `DEVICE_KEYS`, `ONE_TIME_KEYS`, `CROSS_SIGNING_KEYS`, `CACHE`, `ACCOUNT_DATA`
- R2 `MEDIA` — Media file storage

**Key patterns:**

- Auth: token from `Authorization: Bearer` or `?access_token=`, SHA-256 hashed, looked up in D1 `access_tokens`. Middleware sets `userId`/`deviceId` on context.
- Errors: Use `MatrixApiError` class and `Errors` factory for standardized Matrix JSON responses (`errcode`, `error`).
- Database: Direct D1 prepared statements — no ORM. All queries in `src/services/database.ts` or inline in route handlers.
- IDs follow Matrix format: `@user:domain`, `!room_id:domain`, `$event_id:domain`, `#alias:domain`.
- Federation: Ed25519 signing, X-Matrix header validation, server key caching in KV.
- Real-time: Hibernatable WebSockets via RoomDurableObject, long-polling `/sync`, Sliding Sync (MSC3575/MSC4186) for Element X.
- Passwords hashed with PBKDF2-SHA256 (100,000 iterations).

**TypeScript config:** Strict mode, ES2022 target, `@/*` path alias maps to `src/*`, `@cloudflare/workers-types`.

## Spec Coverage Workflow

- The local spec clone lives under `.saqula/matrix-spec`.
- Primary checklist coverage should be derived from Markdown spec structure in:
  - `content/client-server-api/_index.md`
  - `content/client-server-api/modules/*.md`
  - `content/server-server-api.md`
- OpenAPI files under `data/api/client-server` and `data/api/server-server` are the primary endpoint coverage inventory.
- `matrix-org/complement` is an evidence source for interoperability and black-box compliance testing, not the primary checklist coverage source.
- When editing `docs/matrix/speccheck-matrix-v2.md` or related coverage docs:
  - cite exact spec section/module titles where possible
  - keep coverage rows aligned with extracted Markdown units
  - use OpenAPI filenames as the endpoint coverage backbone
  - keep `docs/spec-coverage/openapi-row-map.json` aligned with the rows in `docs/matrix/speccheck-matrix-v2.md`
  - treat Complement as evidence for implementation claims, not as a substitute for checklist completeness

## Git Commit Rules

- Never include Codex attribution (e.g., `Co-Authored-By`) in commit messages.
