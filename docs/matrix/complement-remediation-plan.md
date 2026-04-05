# Complement Remediation Plan

Current triage and remediation notes for the latest broad Complement rerun.
Last updated: 2026-04-05.

This document is for active debugging and repair planning.
It complements `docs/matrix/complement-analysis.md`, which remains the current-state evidence and baseline document.

## Current Diagnostic Snapshot

Artifacts:

- raw log: [`2026-04-05_07-56-40-49151.log`](/Users/saqula/Documents/02_codes/github.com/aluqas/faas-matrix/logs/2026-04-05_07-56-40-49151.log)
- summary: [`2026-04-05_07-56-40-49151.summary.json`](/Users/saqula/Documents/02_codes/github.com/aluqas/faas-matrix/logs/2026-04-05_07-56-40-49151.summary.json)
- classified: [`2026-04-05_07-56-40-49151.classified.json`](/Users/saqula/Documents/02_codes/github.com/aluqas/faas-matrix/logs/2026-04-05_07-56-40-49151.classified.json)
- docker log: [`2026-04-05_07-56-40-49151.docker.log`](/Users/saqula/Documents/02_codes/github.com/aluqas/faas-matrix/logs/2026-04-05_07-56-40-49151.docker.log)

Result:

- top-level summary: `207 total / 129 pass / 76 fail / 2 skip`
- overall classification: `mixed`

Interpretation:

- this run improved over the earlier deep diagnostic run (`118 pass / 87 fail / 2 skip`)
- it is still not the docs/spec baseline because classification remains `mixed`
- it is strong backlog and regression-triage evidence, not stable pass-rate evidence

## Concrete Failure Signatures

### 1. Media async upload surface is still incomplete

Observed failure:

- `TestAsyncUpload` fails immediately because Complement calls `POST /_matrix/media/v1/create`
- the server returns `404 Not Found`

Working interpretation:

- the implementation currently exposes async upload create under `/_matrix/client/v1/media/create`
- the `/_matrix/media/v1/create` alias expected by Complement is missing
- this is a route compatibility gap, not a deep media pipeline bug

Relevant code:

- `src/api/media.ts`
- `src/index.ts`

### 2. Unknown media endpoints do not consistently return Matrix JSON errors

Observed failure:

- `TestUnknownEndpoints/Media_endpoints` fails because `/_matrix/media/unknown` returns a non-JSON 404 body

Working interpretation:

- top-level fallback handling in `src/index.ts` is Matrix-shaped
- lazy-loaded media routes are bypassing that behavior for unknown media paths
- the route boundary between the root app and `src/api/media.ts` is not preserving a shared Matrix error contract

Relevant code:

- `src/index.ts`
- `src/api/media.ts`

### 3. Presence is stored, but not reliably projected into `/sync`

Observed failures:

- `TestPresence/Presence_can_be_set_from_sync`
- `TestPresence/Presence_changes_are_reported_to_local_room_members`
- `TestRemotePresence/Presence_changes_to_UNAVAILABLE_are_reported_to_remote_room_members`

Observed pattern:

- `PUT /_matrix/client/v3/presence/:userId/status` succeeds
- subsequent `/sync` polling repeatedly reports "did not find ... in presence events"

Working interpretation:

- setting presence is not the primary problem
- projection into top-level `/sync` and/or federation EDU propagation is incomplete or inconsistent
- `unavailable` transitions are especially suspect

Relevant code:

- `src/api/presence.ts`
- `src/matrix/application/features/presence/project.ts`
- `src/matrix/application/features/sync/top-level.ts`
- `src/api/sliding-sync.ts`
- `src/matrix/application/features/federation/edu-ingest.ts`

### 4. Device-scoped login and txn idempotency are not robust

Observed failure:

- `TestTxnIdempotencyScopedToDevice` hits `POST /_matrix/client/v3/login => 500 Internal Server Error`

Working interpretation:

- login creates a device unconditionally
- `createDevice()` is a plain insert without reuse/upsert behavior
- repeated login with the same device identifier likely throws a database error instead of reusing the device or returning a controlled Matrix error

Relevant code:

- `src/api/login.ts`
- `src/services/database.ts`

### 5. Restricted join semantics are under-modeled

Observed failures:

- `TestRestrictedRoomsLocalJoinInMSC3787Room/Join_should_succeed_when_joined_to_allowed_room`
- related `TestRestrictedRooms*` and `TestKnock*` families in the same broad run

Observed pattern:

- the user joins the allowed room successfully
- the follow-up join into the restricted room still returns `403`

Working interpretation:

- local join authorization currently treats restricted joins as authorized only when `join_authorised_via_users_server` is present
- allowed-room membership and restricted join rules are not being fully evaluated for local joins
- the same semantic family likely affects multiple restricted and knock room tests

Relevant code:

- `src/matrix/application/room-service.ts`
- `src/matrix/application/room-membership-policy.ts`
- `src/services/event-auth.ts`
- `src/api/federation/membership.ts`

### 6. Room version 12 / MSC4291 create-event semantics remain incomplete

Observed failures:

- `TestMSC4291RoomIDAsHashOfCreateEvent_CannotSendCreateEvent`
- `TestMSC4291RoomIDAsHashOfCreateEvent_UpgradedRooms`
- `TestComplementCanCreateValidV12Rooms`
- `TestMSC4311FullCreateEventOnStrippedState`

Observed pattern:

- sending a replacement `m.room.create` event is accepted when Complement expects rejection
- upgraded room IDs are not derived from the create event hash
- v12 federation paths can report `No m.room.create event in room state`

Working interpretation:

- room-version-12 behavior is not isolated in one place
- create event generation, room ID derivation, room upgrade carry-over, and federation state bundle assembly are drifting apart
- this is a semantics-layer problem, not a single endpoint bug

Relevant code:

- `src/api/rooms/lifecycle.ts`
- `src/matrix/application/federation-handler-service.ts`
- `src/api/federation/membership.ts`
- `src/services/event-auth.ts`

### 7. Device-list propagation on room join still needs targeted reproduction

Observed failure:

- `TestDeviceListsUpdateOverFederationOnRoomJoin`

Working interpretation:

- the broad run confirms the bucket is still red
- aggregate logs do not yet expose a concise final assertion signature
- current suspicion remains the "newly shared servers after join" publication path

Relevant code:

- `src/matrix/application/room-service.ts`
- `src/matrix/application/features/device-lists/command.ts`
- `src/services/device-key-changes.ts`

## Architecture Findings

### 1. Several route files are too large and mix too many responsibilities

Most concerning examples:

- `src/api/sliding-sync.ts`
- `src/api/admin.ts`
- `src/api/media.ts`
- `src/api/federation/membership.ts`
- `src/api/keys.ts`

Why this matters:

- route parsing, validation, business rules, persistence, projection, and error shaping are co-located
- room-version-specific and federation-specific branches are hard to reason about in review
- regression fixes are likely to be local patches without a stable abstraction boundary

### 2. Presence logic is duplicated across multiple projection paths

Current spread:

- write path in `src/api/presence.ts`
- sync projection in `src/matrix/application/features/presence/project.ts`
- top-level `/sync` assembly in `src/matrix/application/features/sync/top-level.ts`
- sliding-sync presence assembly in `src/api/sliding-sync.ts`
- federation EDU ingest in `src/matrix/application/features/federation/edu-ingest.ts`

Why this matters:

- local and federated presence behavior can diverge
- `/sync` and sliding-sync can drift in what they publish
- fixing one presence surface does not guarantee consistent behavior elsewhere

### 3. Membership and join authorization are spread across too many layers

Current spread:

- `src/matrix/application/room-service.ts`
- `src/matrix/application/room-membership-policy.ts`
- `src/services/event-auth.ts`
- `src/api/federation/membership.ts`

Why this matters:

- restricted join, knock, leave, and invite rules are encoded multiple times
- client-side and federation-side behaviors can become inconsistent
- room-version-specific semantics are hard to keep aligned

### 4. Validation and error-contract rigor are inconsistent across APIs

Examples:

- `src/api/filter-validation.ts` is relatively strict and explicit
- `src/api/login.ts`, `src/api/media.ts`, and `src/api/presence.ts` still lean heavily on ad-hoc parsing and route-local error shaping

Why this matters:

- unknown endpoint behavior and invalid request handling are inconsistent
- lazy-loaded route groups can leak plain text or framework-default responses
- Complement failures around edge behavior are more likely

### 5. Device lifecycle assumptions are fragile

Current smell:

- login assumes device creation is always a fresh insert
- repeated device-scoped login is not modeled as a first-class lifecycle path

Why this matters:

- device reuse, access-token rotation, txn semantics, and key upload behavior all depend on this boundary
- failures here can fan out into device-list and E2EE regressions

## Repair Plans

## Plan A: Fast compatibility wins

Target:

- `TestAsyncUpload`
- `TestUnknownEndpoints/Media_endpoints`
- `TestTxnIdempotencyScopedToDevice`

Actions:

- add `/_matrix/media/v1/create` compatibility for async upload create
- ensure unknown media endpoints return Matrix JSON error bodies
- make login/device creation idempotent for repeated `(user_id, device_id)` logins

Expected effect:

- quick pass-count improvement
- reduced noise from obvious route compatibility and device lifecycle gaps

## Plan B: Presence projection unification

Target:

- `TestPresence*`
- `TestRemotePresence*`

Actions:

- define one canonical presence read model used by top-level `/sync`, sliding-sync, and federated presence delivery
- verify that `online -> unavailable` transitions are projected, not just stored
- ensure room visibility filtering still feeds the same projection pipeline

Expected effect:

- resolves a high-value user-visible feature area
- reduces duplicated presence logic and future drift

## Plan C: Join and membership authorization consolidation

Target:

- `TestRestrictedRooms*`
- `TestKnock*`
- `TestDeviceListsUpdateOverFederationOnRoomJoin`

Actions:

- centralize local and federated join authorization inputs into one service/context
- model restricted joins with explicit allow-rule evaluation instead of relying on `join_authorised_via_users_server` alone
- feed the same authorization facts into room-service, federation membership routes, and event auth

Expected effect:

- repairs a broad cluster of restricted/join semantics
- reduces duplicated room-version logic

## Plan D: Room-version create-event semantics extraction

Target:

- `TestMSC4291RoomIDAsHashOfCreateEvent*`
- `TestComplementCanCreateValidV12Rooms`
- `TestMSC4311FullCreateEventOnStrippedState`

Actions:

- isolate room-version-12 create-event rules in a dedicated module
- make room ID derivation, create-event immutability, and upgrade semantics explicit
- use the same module when constructing federation state bundles and local room creation state

Expected effect:

- addresses a structurally complex failure cluster
- avoids incremental endpoint-specific patching that reintroduces inconsistencies

## Recommended Execution Order

When optimizing for the broadest immediate pass-count increase with minimal structural change:

1. Plan A
2. Plan B
3. Plan C
4. Plan D

Reasoning:

- Plan A has the clearest failure signatures and the smallest implementation surface
- Plan B fixes a broad user-visible behavior family with repeated current regressions
- Plan C benefits from a small amount of design work before implementation
- Plan D is the deepest semantics refactor and should be done after the lower-risk wins

When optimizing for long-term codebase reuse and reducing the current "if guard" growth:

1. Plan C
2. Plan B
3. Plan D
4. Plan A only where still needed

Reasoning:

- Plan C removes the most duplicated specification logic and is the largest source of guard proliferation
- Plan B benefits from a single projection model and reduces duplicated read-path behavior
- Plan D is easier once membership and projection boundaries are cleaner
- Plan A is still valid for tactical compatibility work, but it should not dominate the architecture if compatibility is not a priority

## Incremental TDD-First Rearchitecture

Current preferred direction:

- avoid a whole-codebase big-bang rewrite
- use currently failing Complement tests as the entry point for incremental TDD work
- let each repaired failure pull one narrow piece of architecture into a cleaner boundary

Working rule:

- do not add another endpoint-local guard if the failing test is actually exposing shared semantics
- instead, extract the shared semantics behind the specific failure, move that logic once, and then make the route call the new boundary

Practical execution model:

1. pick one failing test family
2. reproduce it in a tight targeted rerun
3. identify the duplicated semantic decision that the test is stressing
4. extract a small domain service/policy around that decision
5. move just enough callers onto the new boundary to make the test pass
6. keep the old surface stable until adjacent failures justify moving the next caller

Good first candidates for this style:

- `TestRestrictedRooms*` and `TestKnock*` for membership/join authorization extraction
- `TestPresence*` and `TestRemotePresence*` for presence projection extraction
- `TestMSC4291RoomIDAsHashOfCreateEvent*` and `TestComplementCanCreateValidV12Rooms` for room-version semantics extraction

Expected benefit:

- red tests are converted into domain boundaries one cluster at a time
- architecture improves as a side effect of test repair, instead of being deferred to a risky later rewrite
- the codebase keeps moving while avoiding a new layer of unstructured patch logic

## Effect Adoption Notes

The current stack already has a workable foundation for deeper `Effect` adoption:

- `DomainError` / `InfraError`
- effect runtime boundaries in `src/matrix/application/effect-runtime.ts`
- policy-style `Effect` usage in membership code
- port-style `Effect.tryPromise` adapters in sync and federation features

This suggests an incremental path rather than an all-or-nothing migration.

Recommended `Effect` scope for the next phase:

- use `Effect` to model domain policy and workflows
- use ports and adapters for D1, KV, Durable Objects, and federation side effects
- keep Hono routes thin as decode/encode boundaries

What should move into `Effect` first:

- join and membership authorization decisions
- presence projection and visibility rules
- room-version-specific create-event semantics

What should stay thin:

- Hono route handlers
- request parsing and response shaping
- top-level app composition

Anti-goal:

- do not mechanically rewrite existing Promise code into `Effect.gen(...)` without first improving the domain model
- that would preserve the same branching complexity while adding abstraction overhead

Desired end state:

- routes become transport adapters
- specification decisions live in typed domain services
- cross-cutting behaviors are encoded once and reused across client, federation, workflow, and durable-object boundaries

Stack note:

- `Hono + Effect` remains a strong fit here
- if validation is revisited later, it should be in service of the same goal: typed, reusable semantic boundaries rather than more route-local guards

## Documentation Guidance

Use this document as:

- the active triage and repair plan for the broad `2026-04-05` mixed run
- a reference when choosing targeted reruns and implementation order

Do not use this document alone as spec evidence:

- stable docs/spec evidence still comes from `docs/matrix/complement-analysis.md`
- mixed-run red should still be treated as backlog signal until reproduced cleanly
