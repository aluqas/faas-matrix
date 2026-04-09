# Directory Split Options

This note compares candidate directory splits for the ongoing incremental rearchitecture.

The goal is not to trigger a big-bang rename. The goal is to make future extraction work more deterministic by fixing the intended boundaries first.

## What The Current Tree Already Suggests

The repository already contains the seeds of the target split:

- `src/api/`
  - Hono routes and transport-facing request/response shaping
- `src/matrix/`
  - Matrix-specific application, domain, repositories, and feature logic
- `src/foundation/`
  - runtime-agnostic app context, capabilities, and idempotency
- `src/fedcore/`
  - federation substrate contracts intended to outlive Matrix-only code
- `src/runtime/cloudflare/`
  - Cloudflare-specific bindings and adapters

The problem is not that the target shape is invisible. The problem is that the boundaries are still porous.

Examples of current boundary leakage:

- `src/runtime/cloudflare/matrix-repositories.ts`
  - imports `../../api/receipts`, `../../api/to-device`, and `../../api/typing`
  - runtime code should not depend on HTTP route modules
- `src/matrix/application/features/sync/top-level.ts`
  - imports `../../../../api/push`
  - application code should not depend on transport code
- `src/services/push-rule-evaluator.ts`
  - imports `../api/push`
  - shared/service code is still reaching into route modules
- multiple route modules under `src/api/rooms/` and `src/api/federation/`
  - still call `src/services/database.ts` directly
  - this keeps transport, orchestration, and persistence concerns mixed

Those import directions matter more than file size alone. If they stay ambiguous, any directory split will degrade back into a large shared bucket.

## Evaluation Criteria

Main criteria for this comparison:

- boundary clarity
- ease of future refactoring
- readability of structure and ownership
- portability of reusable substrate
- migration risk under the current TDD-first incremental strategy

## Option A: Keep The Current Roots And Clean Them Up

Shape:

- `src/api/`
- `src/matrix/`
- `src/foundation/`
- `src/fedcore/`
- `src/runtime/cloudflare/`

Pros:

- lowest rename cost
- already aligned with current docs
- easiest option if the next phase is mostly import cleanup

Cons:

- `foundation` and `fedcore` are conceptually meaningful but easy to misread from the outside
- the current top-level names do not strongly communicate the transport/backend/runtime split
- old buckets such as `src/services/`, `src/types/`, and `src/utils/` remain semantically overloaded

Assessment:

- good as an intermediate state
- weak as the final naming model if the main goal is clearer responsibility boundaries

## Option B: Three Roots

Shape:

- `src/matrix-api/`
- `src/matrix-backend/`
- `src/fetherate/`

Pros:

- much clearer than the current mixed top-level tree
- makes the distinction between HTTP transport and backend logic explicit
- gives reusable FaaS-native substrate a named home

Cons:

- Cloudflare runtime code does not have a clean home
- Durable Objects, Workflows, D1/KV/R2 adapters, and per-request app context assembly are neither `matrix-api` nor `matrix-backend`
- if runtime code is pushed into `fetherate`, `fetherate` stops being portable
- if runtime code is pushed into `matrix-api`, transport and platform concerns get mixed

Assessment:

- good naming direction
- incomplete boundary model for this repo as it exists today

## Option C: Four Roots

Shape:

- `src/matrix-api/`
- `src/matrix-backend/`
- `src/fetherate/`
- `src/runtime-cloudflare/`

Pros:

- clearest responsibility split for the current system
- preserves a clean home for Cloudflare-only code
- lets `fetherate` stay runtime-agnostic and potentially reusable by ActivityPub, Mastodon-like services, or other FaaS-native SaaS backends
- matches the current reality that this codebase has both protocol/application concerns and deployment-platform concerns

Cons:

- one more top-level root than the initial draft
- requires discipline so `matrix-api` route modules do not directly accumulate runtime adapters

Assessment:

- best fit for the current repo
- strongest long-term option for incremental extraction

## Option D: Feature-First Vertical Slices

Shape:

- `src/features/rooms/{api,application,domain,runtime}`
- `src/features/profile/{api,application,domain,runtime}`
- `src/features/federation/{api,application,domain,runtime}`

Pros:

- very strong local discoverability per feature
- useful once a feature is already cleanly bounded

Cons:

- conflicts with the standing rule that endpoint presence should remain structurally obvious in `api/*`
- tends to duplicate cross-feature runtime and transport patterns before common seams are stable
- harder during migration because old shared services still cut across many features

Assessment:

- good for selected backend internals
- not a good primary top-level split yet

## Comparison Summary

| Option | Boundary clarity | Refactorability | Readability | Portability | Migration fit |
| --- | --- | --- | --- | --- | --- |
| A. current roots, cleaner imports | medium | medium | medium | medium | high |
| B. three roots | high | high | high | medium | medium |
| C. four roots | very high | very high | high | high | high |
| D. feature-first top level | medium | medium | high inside a feature | medium | low |

Recommended direction: Option C.

## Recommended Target Shape

Recommended top-level shape inside `src/`:

```text
src/
  matrix-api/
    api/
    middleware/
    codecs/
    bootstrap/
  matrix-backend/
    application/
    domain/
    repositories/
    features/
    schema/
    errors/
    types/
  fetherate/
    foundation/
    contracts/
    capabilities/
    federation/
    idempotency/
  runtime-cloudflare/
    app-context/
    repositories/
    adapters/
    durable-objects/
    workflows/
    transport/
```

Important interpretation rules:

- `matrix-api`
  - owns Hono route modules and transport-level decode/encode boundaries
  - keeps `app.get` and `app.post` structurally visible
- `matrix-backend`
  - owns Matrix-specific use-cases, validation, schema, DTOs, projectors, errors, policies, and repository contracts
  - if it cannot reasonably be reused outside Matrix, it belongs here
- `fetherate`
  - owns only runtime-agnostic substrate that could support another FaaS-native backend
  - it must not depend on Matrix-specific types, Hono, or Cloudflare bindings
- `runtime-cloudflare`
  - owns Workers-specific composition and adapters
  - Durable Objects and Workflows belong here, not in `matrix-backend`

## Dependency Rules

Allowed dependency directions:

- `matrix-api -> matrix-backend`
- `matrix-api -> fetherate`
- `runtime-cloudflare -> matrix-backend`
- `runtime-cloudflare -> fetherate`
- `matrix-backend -> fetherate`

Disallowed dependency directions:

- `matrix-backend -> matrix-api`
- `fetherate -> matrix-backend`
- `fetherate -> matrix-api`
- `fetherate -> runtime-cloudflare`
- `runtime-cloudflare -> matrix-api`

Operational rule:

- no top-level catch-all buckets in the target state
- avoid new generic roots like `services`, `utils`, or `types`
- new code should choose an owning boundary first, then add the file there

## What Moves Where

Suggested mapping from the current tree:

- `src/api/*` -> `src/matrix-api/api/*`
- `src/middleware/*` -> `src/matrix-api/middleware/*`
- `src/matrix/*` -> `src/matrix-backend/*`
- `src/foundation/*` -> `src/fetherate/foundation/*`
- `src/fedcore/*` -> `src/fetherate/federation/*` or `src/fetherate/contracts/*`
- `src/runtime/cloudflare/*` -> `src/runtime-cloudflare/*`
- `src/durable-objects/*` -> `src/runtime-cloudflare/durable-objects/*`
- `src/workflows/*` -> `src/runtime-cloudflare/workflows/*`

Current shared buckets should be retired gradually:

- `src/services/*`
  - split into `matrix-backend` use-case helpers, `runtime-cloudflare` adapters, or `fetherate` contracts
- `src/types/*`
  - move Matrix-specific types into `matrix-backend`
  - move portable capability or contract types into `fetherate`
- `src/utils/*`
  - move by ownership, not by helper-ness

## Migration Sequence

Recommended sequence:

1. Fix dependency direction before mass renaming.
2. Remove runtime -> api imports.
3. Remove backend -> api imports.
4. Pull shared contracts out of `src/services`, `src/types`, and `src/utils`.
5. Rename top-level directories only after the import graph reflects the intended boundaries.
6. Consider package-level extraction only after the directory boundaries stop moving.

That last point matters. A package split is a packaging decision, not the first architectural decision. Do the semantic split first. Promote to workspaces later if the imports stay stable.

## First Practical Targets

High-value first targets for cleanup before any mass move:

- extract route-owned helpers out of `src/api/push.ts` so sync code stops importing from `api`
- extract `getReceiptsForRoom`, `getToDeviceMessages`, and `getTypingUsers` out of route modules into backend/runtime-owned ports
- keep moving `src/api/rooms/*` and `src/api/federation/*` from direct `services/database.ts` access to feature-level ports/adapters
- move contract-style files such as `src/api/keys-contracts.ts` out of `api` into backend-owned schema/contracts

## Recommendation In One Sentence

Use the three-root draft as the semantic core, but make the actual top-level split four roots by adding `runtime-cloudflare`; otherwise the platform boundary remains blurred and `fetherate` will be forced to absorb code that should stay deployment-specific.
