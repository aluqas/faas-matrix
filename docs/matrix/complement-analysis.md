# Complement Gap Analysis

Complement black-box integration test results and failure root-cause analysis.
Last updated: 2026-03-27. Based on test runs test1–test5.

## Test Run Progression

| Run | Total | Pass | Fail | Skip | Notes |
|-----|-------|------|------|------|-------|
| test1 | 62 | 0 (0%) | 62 | 0 | Baseline. Migration schema gaps cause 500 on most routes. |
| test2 | 71 | 0 (0%) | 71 | 0 | Additional test suites added. Same root causes. |
| test3 | 21 | 2 (10%) | 19 | 0 | Migration fix applied. Timeout at 603s (server slower now it works). |
| test4 | 42 | 3 (7%) | 39 | 0 | Migration batching fix. Container startup faster, more tests complete. |
| test5 | 200 | 34 (17%) | 165 | 1 | TypeScript pre-bundle + nginx simplification. First broad coverage. |

**Cumulative fixes that produced pass gains (test1 → test5):**
- `TestIsDirectFlagLocal` ✅
- `TestInboundFederationProfile/Inbound_federation_can_query_profile_data` ✅
- `TestJoinViaRoomIDAndServerName` ✅
- 31 additional tests newly reachable in test5 (SendLeave, SendKnock, RestrictedRooms, media thumbnails, etc.)

---

## Infrastructure Fixes Applied

These are not spec failures but blocked all test progress:

### 1. Migration double-execution (`entrypoint.sh`)
`./migrations/*.sql` glob included `schema.sql`, causing it to run twice. Combined with persistent `PERSIST_DIR`, this produced `SQLITE_ERROR: duplicate column name: private_key_jwk` on container start, preventing health check from passing for federation (hs2) containers.

**Fix:** `rm -rf "${PERSIST_DIR}"` on startup + glob changed to `./migrations/[0-9]*.sql`.

### 2. Migration called 16× per container start
Each migration file was a separate `wrangler d1 execute` invocation. Wrangler starts Node.js + loads its bundle on each call (~2–3s each = 30–50s per container).

**Fix:** Concatenate all SQL files and run a single wrangler call.

### 3. TypeScript compiled on every container start
`wrangler dev` re-bundles and compiles TypeScript from source on each container start.

**Fix:** `wrangler deploy --dry-run --outdir dist` in Dockerfile build step; entrypoint uses `--no-bundle` to serve the pre-compiled bundle.

### 4. nginx proxying client traffic unnecessarily
nginx proxied both port 8008 (HTTP) and 8448 (HTTPS). Port 8008 needed no TLS termination.

**Fix:** wrangler now listens directly on `0.0.0.0:8008`. nginx retained only for port 8448 (TLS termination for federation).

---

## Failure Categories (test5, 165 failures)

### A. Foreign key constraint on federation invite (11 failures)
**Tests:** `TestFederationRoomsInvite`
**Error:** `D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT`
**Root cause:** Federation invite processing attempts to INSERT a membership row without the required parent room record existing first. Insert order or missing room bootstrap in the federated invite flow.
**Spec ref:** server-server-api.md §Inviting to a room
**Priority:** High — blocks all federation invite flows.

### B. `send_join` accepts non-join events (14 failures)
**Tests:** `TestCannotSendNonJoinViaSendJoinV1` (7), `TestCannotSendNonJoinViaSendJoinV2` (7)
**Error:** `make_join` returns 200, but `send_join` does not reject events whose `type` or `content.membership` is not `join`.
**Root cause:** `send_join` handler in `src/api/federation.ts` likely missing event-type validation before persistence.
**Spec ref:** server-server-api.md §Joining Rooms
**Priority:** High — spec requires rejection of non-join events via this endpoint.

### C. Missing events endpoint returns empty/errors (5 failures)
**Tests:** `TestInboundCanReturnMissingEvents`
**Error:** No server logs in output — endpoint likely returns immediately without fetching.
**Root cause:** `GET /_matrix/federation/v1/get_missing_events/:roomId` implementation does not traverse the event DAG to find requested events.
**Spec ref:** server-server-api.md §Retrieving Missing Events
**Priority:** High — needed for federation state recovery.

### D. `invite_state` missing from sync invite section (8 failures)
**Tests:** `TestDeviceListsUpdateOverFederation` (4), `TestIsDirectFlagFederation` (1), others
**Error:** `rooms.invite.*.invite_state.events` key absent — sync returns `{"events":[]}` for invited rooms.
**Root cause:** Sync service does not attach stripped state events to the invite section of the sync response.
**Code ref:** `src/api/sync.ts` invite room handling
**Spec ref:** client-server-api/_index.md §Syncing — invite_state
**Priority:** High — required for clients to display room info on invite.

### E. Unknown endpoints return 404 instead of 405 (5 failures)
**Tests:** `TestUnknownEndpoints`
**Error:** `PATCH /_matrix/media/v3/upload` → 404; spec requires 405 Method Not Allowed when the path is known but the method is not.
**Root cause:** Hono route definitions do not register the path with all methods, so unregistered methods fall through to a 404 catch-all instead of 405.
**Spec ref:** client-server-api/_index.md §API Standards — Unknown endpoints
**Priority:** Medium — quick fix, affects Complement's unknown-endpoint test suite.

### F. Empty `state_key` in `join_rules` state route (8 failures)
**Tests:** `TestRestrictedRoomsLocalJoin` (4), `TestRestrictedRoomsLocalJoinInMSC3787Room` (4)
**Error:** `PUT /rooms/:id/state/m.room.join_rules/` → 404 `M_UNRECOGNIZED`
**Root cause:** Route definition in `src/api/rooms.ts` likely requires `:stateKey` to be non-empty. Trailing `/` (empty state_key) is not handled.
**Spec ref:** client-server-api/_index.md §Room State
**Priority:** Medium — blocks restricted room tests.

### G. Space hierarchy does not reflect redactions (6 failures)
**Tests:** `TestClientSpacesSummary`
**Error:** `/hierarchy` returns child rooms even after `m.space.child` event is redacted.
**Root cause:** `src/api/spaces.ts` hierarchy traversal reads current state without checking redaction status of `m.space.child` events.
**Spec ref:** client-server-api modules/spaces.md
**Priority:** Medium.

### H. Rate limiter triggers during tests (17 failures)
**Tests:** `TestMSC4289PrivilegedRoomCreators` (12+), others
**Error:** `429 M_LIMIT_EXCEEDED` returned during rapid sequential requests within a single test.
**Root cause:** Rate limiter `RateLimitDurableObject` does not distinguish test environments. Complement hammers endpoints in rapid sequence, hitting limits designed for production.
**Code ref:** `src/durable-objects/RateLimitDurableObject.ts`, middleware
**Priority:** Medium — test environment should disable or relax rate limiting. `MATRIX_FEATURE_PROFILE=core` could gate it.

### I. Unimplemented or out-of-scope (remaining ~100 failures)
Features not yet implemented. Not regressions.

| Category | Tests | Notes |
|----------|-------|-------|
| To-device over federation | `TestToDeviceMessagesOverFederation` (4) | Federation EDU delivery for to-device |
| Remote presence | `TestRemotePresence` (3) | Presence EDU federation |
| Federation invite full flow | `TestFederationRoomsInvite` partial | Beyond FK fix, full invite handshake |
| Remote join validation | `TestJoinFederatedRoomWithUnverifiableEvents` (5) | Unverifiable event rejection |
| Auth chain / state resolution | `TestEventAuth`, `TestCorruptedAuthChain`, `TestInboundFederationRejectsEventsWithRejectedAuthEvents` | Event auth correctness |
| Knocking | `TestKnocking`, `TestKnockingInMSC3787Room` | Room version 7/11 knocking |
| MSC4289 (Privileged room creators) | 12+ | v12 room feature, not yet implemented |
| MSC4291 (Room ID as hash) | 5+ | Experimental room version |
| MSC4297 (State resolution v2) | 2 | State resolution extension |
| MSC4311 | 1 | |
| Remote media | `TestContentMediaV1`, `TestRemotePngThumbnail` | `media.ts` explicitly returns "not supported" |
| Spaces federation | `TestFederatedClientSpaces`, `TestRestrictedRoomsSpacesSummaryFederation` | |

---

## Fix Priority Summary

| Priority | Category | Estimated scope |
|----------|----------|-----------------|
| 🔴 High | A — FK constraint (federation invite) | `federation.ts` insert order fix |
| 🔴 High | B — send_join event type validation | `federation.ts` handler check |
| 🔴 High | C — get_missing_events implementation | `federation.ts` DAG traversal |
| 🔴 High | D — invite_state in sync | `sync.ts` invite section |
| 🟡 Medium | E — 405 vs 404 unknown methods | Hono route registration |
| 🟡 Medium | F — empty state_key routing | `rooms.ts` route pattern |
| 🟡 Medium | G — space hierarchy + redactions | `spaces.ts` state filter |
| 🟡 Medium | H — rate limiter in test env | Feature profile or env flag |
| ⚪ Later | I — unimplemented features | Scoped per MSC/spec section |
