# Matrix Compatibility Checklist

This checklist complements `docs/speccheck-matrix.md`.
`speccheck-matrix.md` tracks endpoint and feature surface.
This document tracks the additional conditions required to move from endpoint coverage toward genuine Matrix compatibility and eventually full spec-grade behavior.

## Source Baseline

This checklist is grounded in:

- Matrix Specification v1.17, especially room versions and server-server semantics.
- Matrix room version rules for authorization, redaction, canonical JSON, and state resolution.
- Matrix Complement, the black-box integration test suite for homeservers.
- Existing homeserver practice from Synapse and Dendrite, especially their test-driven compatibility posture and explicit compatibility scope.

## Compatibility Target Definition

- [ ] Define what `Matrix-compatible` means for this repo in terms of behavior, not endpoint count.
- [ ] Define what `full spec implementation` means for this repo in terms of room versions, federation flows, and client interoperability.
- [ ] Document supported room versions explicitly.
- [ ] Document unsupported APIs, MSCs, and behavioral gaps explicitly.
- [ ] Treat `demo`, `experimental`, `core`, `lite`, and `full` as explicit product profiles with documented scope.
- [ ] Separate `implemented route`, `behaviorally compatible flow`, and `federation-safe implementation` as different milestones.

## Room And Event Semantics

- [ ] Supported room versions are listed explicitly, with unsupported versions rejected rather than guessed.
- [ ] Default room version is chosen deliberately and documented against the current spec recommendation.
- [ ] Room state is modeled as a replicated event graph, not as ad hoc mutable room records.
- [ ] Event auth is enforced for all event-producing flows, not only selected endpoints.
- [ ] Power levels are checked consistently for send, redact, invite, kick, ban, and state changes.
- [ ] Membership transitions follow Matrix rules for join, leave, invite, knock, ban, and restricted join.
- [ ] Restricted joins and `join_authorised_via_users_server` are handled per room-version rules when claimed.
- [ ] Auth chain lookup and state resolution are applied where federation requires them.
- [ ] State resolution differences between room versions are implemented intentionally, not treated as one generic algorithm.
- [ ] Backfill and missing-event handling do not create invalid local state.
- [ ] Event depth, prev events, auth events, hashes, and signatures are validated before persistence.
- [ ] Canonical JSON rules are applied anywhere signatures or event hashes depend on them.
- [ ] Redaction behavior follows the room-version-specific redaction algorithm rather than generic field deletion.
- [ ] Unsupported behavior fails closed with clear errors instead of silently accepting invalid events.
- [ ] **Auth Chain Completeness**: Missing `auth_events` attached to an incoming PDU are recursively fetched from the originating server and validated before the event is accepted.
- [ ] **Strict Event Authorization**: Fetched events strictly pass the `Allowed` checks against their resolved auth chain, not just generic validation.
- [ ] **State Fork & Merge Handling**: Network partitions that physically diverge the event graph (forks) natively trigger the full Matrix State Resolution algorithm (v2, etc.) to deterministically merge states automatically.
- [ ] **Partial State Transitions**: If joining a room without receiving full state, the server safely flags it as 'Partial State' and operates in degraded mode while transitioning to 'Full State' asynchronously.

## Federation Safety

- [ ] Incoming federation PDUs are verified before they affect room state or memberships.
- [ ] `/send`, `/make_join`, `/send_join`, `/make_leave`, `/send_leave`, `/make_knock`, `/send_knock`, and invite flows are tested as protocol flows, not just as route handlers.
- [ ] Local bounds and caching expiry configurations actively protect against remote payload size attacks.
- [ ] Remote joins, invites, knocks, and leaves are validated against room version rules.
- [ ] Remote key discovery, caching, and expiry are documented and tested.
- [ ] Replay protection and transaction idempotency are enforced for inbound federation transactions.
- [ ] Outbound federation retries do not duplicate or reorder state-changing operations unsafely.
- [ ] Partial federation failures do not leave room state half-applied.
- [ ] Third-party invite exchange and other special federation flows are covered by compatibility tests.
- [ ] `send_join` handling returns the correct resolved `state` and `auth_chain` for the relevant room version.
- [ ] Federation claims are limited to the room versions and flows that are actually exercised against other homeservers.
- [ ] **Destination Queues & Backoff**: Outbound federation traffic utilizes persistent destination queues with exponential backoff and retry mechanisms to survive long-term remote server downtime.
- [ ] **PDU/EDU Segregation**: Persistent Data Units (PDUs/messages) and Ephemeral Data Units (EDUs/presence, typing) are internally segregated with differing delivery retry guarantees.
- [ ] **Malicious Backfill Protection**: Backfilled events and `get_missing_events` payloads are strictly signature-verified, bounded by hard limits to prevent DoS (resource exhaustion), and topologically sorted by depth before persistence.

## Client Compatibility

- [ ] Element Web login, sync, room send, state updates, media, and E2EE bootstrap are tested against this server.
- [ ] Element X login, sliding sync, timeline updates, receipts, and E2EE bootstrap are tested against this server.
- [ ] If MSC4186 or next-gen auth is not supported, that limitation is called out explicitly because it affects Element X usability.
- [ ] Device list updates, to-device messages, one-time key claim, and cross-signing flows are verified end-to-end.
- [ ] Authenticated media behavior is checked against current client expectations.
- [ ] Sync behavior is correct under reconnect, duplicate delivery, and incremental catch-up.
- [ ] Account data, tags, read markers, and push rule semantics match client expectations.
- [ ] **Out-of-Sync E2EE Detection**: Unrecognized device keys on incoming encrypted (`m.room.encrypted`) messages trigger proactive, background Device List Resynchronization queries against the remote home server.
- [ ] **Scalable Device List Updates**: Remote device list updates correctly queue delta payloads (EDUs), ignoring excessive dumps (>1000 devices) that would cause queue blockage.

## Authorization And Security

- [ ] Every client-server and server-server write path has explicit authorization checks.
- [ ] Authorization is enforced in application services, not only at route level.
- [ ] Unknown or malformed events are rejected before persistence.
- [ ] Security-sensitive TODOs, placeholders, and temporary bypasses are tracked and blocked from release.
- [ ] Signature verification, canonical JSON handling, and hashing behavior are covered by tests.
- [ ] Token validation, refresh, and revocation semantics are documented and tested.
- [ ] Media access control is correct for both authenticated and unauthenticated paths.
- [ ] Admin-only behavior is enforced through dedicated capability checks and tests.

## Storage And State Placement

- [ ] Durable Objects are only used where ordering, coordination, or wake-up semantics are truly required.
- [ ] The system can explain which state lives in D1, KV, R2, DO storage, and why.
- [ ] In-memory state loss does not corrupt persistent room or membership state.
- [ ] Post-commit side effects are separated from transactional state mutation.
- [ ] Recovery from retries, duplicate delivery, and worker restarts is documented and tested.
- [ ] Feature profiles degrade behavior intentionally rather than by missing bindings.
- [ ] **Stream Ordering Monotonicity**: Events persisted concurrently across distributed endpoints/workers maintain a strict, contiguous `stream_ordering`. Clients calling `/sync` never silently skip events due to race conditions.
- [ ] **Receive Queue Isolation**: Incoming federation events during highly concurrent or complex flows (e.g., room joins) are temporarily locked/queued by room ID (`room_queues`) until context/state is fully synchronized.

## Runtime And Portability

- [ ] Matrix domain logic does not depend directly on Cloudflare bindings.
- [ ] Capability interfaces cover storage, jobs, realtime coordination, rate limiting, metrics, and workflows.
- [ ] Cloudflare-specific assumptions are isolated in `src/runtime/cloudflare/`.
- [ ] Any DO-dependent behavior has a documented fallback or explicit portability limitation.
- [ ] Runtime-specific limits that affect compatibility are documented.
- [ ] Portability claims do not erase protocol requirements: FaaS-native architecture cannot skip event auth, state resolution, or federation safety.

## Test And Evidence Requirements

- [ ] Unit tests exist for room creation, join, leave, send, and federation transaction ingestion.
- [ ] Event pipeline tests prove validation, authorization, persistence, fanout, and federation enqueue ordering.
- [ ] Route-level regression tests cover at least create room, send event, sync, and federation send transaction.
- [ ] Complement is part of the compatibility story, not optional future work.
- [ ] A documented Complement target exists for this homeserver, including the runtime contract needed to boot under test.
- [ ] Failing Complement cases are tracked as named gaps rather than hidden behind broad compatibility claims.
- [ ] If a blacklist or allowlist is needed for compatibility suites, it is checked into the repo and reviewed as product scope.
- [ ] Compatibility tests are run against at least one external homeserver.
- [ ] Client interoperability tests are documented with concrete client versions and dates.
- [ ] Known failures are listed publicly instead of being silently omitted from compatibility claims.
- [ ] CI fails on lint, typecheck, and test regressions before release.

## Release Gate

Only call a profile `Matrix-compatible` when all of the following are true:

- [ ] Core room and membership semantics are enforced.
- [ ] Federation safety is validated for supported flows.
- [ ] Client interoperability has been tested and documented.
- [ ] Security-sensitive gaps are tracked and publicly disclosed.
- [ ] The claim matches the exact supported scope, not an aspirational roadmap.
