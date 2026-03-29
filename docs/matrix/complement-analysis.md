# Complement Gap Analysis

Complement black-box integration test results and failure root-cause analysis.
Last updated: 2026-03-30. Based on test runs test1–test9 plus targeted Complement TDD reruns on 2026-03-30.

## Test Run Progression

| Run   | Total | Pass      | Fail | Skip | Notes                                                                                                                 |
| ----- | ----- | --------- | ---- | ---- | --------------------------------------------------------------------------------------------------------------------- |
| test1 | 62    | 0 (0%)    | 62   | 0    | Baseline. Migration schema gaps cause 500 on most routes.                                                             |
| test2 | 71    | 0 (0%)    | 71   | 0    | Additional test suites added. Same root causes.                                                                       |
| test3 | 21    | 2 (10%)   | 19   | 0    | Migration fix applied. Timeout at 603s (server slower now it works).                                                  |
| test4 | 42    | 3 (7%)    | 39   | 0    | Migration batching fix. Container startup faster, more tests complete.                                                |
| test5 | 200   | 34 (17%)  | 165  | 1    | TypeScript pre-bundle + nginx simplification. First broad coverage.                                                   |
| test6 | 336   | 96 (29%)  | 233  | 7    | Broader test suite. 93 new passes (CS API, media, room management).                                                   |
| test7 | 322   | 111 (34%) | 204  | 7    | 15 new passes (Registration, RoomCreate, RoomState, publicRooms).                                                     |
| test8 | 245   | 67 (27%)  | 171  | 7    | `TestWriteMDirectAccountData` newly passing; `TestRemovingAccountData` passing.                                       |
| test9 | 295   | 104 (35%) | 184  | 7    | 37 new passes over test8. Federation invite/leave flow green; restricted remote joins and parts of knocking improved. |

**Cumulative fixes that produced pass gains (test1 → test9):**

- `TestIsDirectFlagLocal` ✅
- `TestInboundFederationProfile/Inbound_federation_can_query_profile_data` ✅
- `TestJoinViaRoomIDAndServerName` ✅
- 31 additional tests newly reachable in test5 (SendLeave, SendKnock, RestrictedRooms, media thumbnails, etc.)
- 93 additional tests in test6 (CS API basics: Login, Registration, Rooms, Media, Profile, Receipts, Presence, Devices, AccountData, DelayedEvents)
- 15 additional tests in test7 (Registration completeness, RoomCreate/RoomState/publicRooms)
- `TestWriteMDirectAccountData` ✅ (test8)
- `TestRemovingAccountData` ✅ (test8, MSC3391 DELETE account_data)
- `TestFederationRoomsInvite` ✅ (test9)
- `TestCannotSendNonLeaveViaSendLeaveV1` ✅ (test9)
- `TestCannotSendNonLeaveViaSendLeaveV2` ✅ (test9)
- `TestRestrictedRoomsRemoteJoin` ✅ subtests in test9
- `TestRestrictedRoomsRemoteJoinInMSC3787Room` ✅ subtests in test9
- Multiple `TestKnocking` / `TestKnockingInMSC3787Room` subtests newly passing in test9

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

## Failure Categories (historical root causes; updated with current TDD status)

The buckets below were first isolated in test5. As of test9 and the targeted Complement TDD reruns on 2026-03-30, the federation invite/leave/join core path has improved substantially: `TestFederationRoomsInvite`, `TestJoinViaRoomIDAndServerName`, `TestCannotSendNonLeaveViaSendLeaveV1`, and `TestCannotSendNonLeaveViaSendLeaveV2` are now passing, and restricted remote joins moved forward as well.

### A. Federation invite / leave full flow is now passing

**Tests:** `TestFederationRoomsInvite`
**Current status:** Passing as of 2026-03-30 targeted rerun. Remote `/federation/v2/invite`, room bootstrap, `invite_room_state`, incoming `unsigned`, local leave/kick federation fanout, `send_leave` persistence, invite-only stub cleanup, and final `/sync` classification now line up with Complement expectations.
**What fixed it:** Centralized `m.room.member` transition handling, remote join workflow completion wait, idempotent event persistence, and stricter federation leave validation.
**Spec ref:** server-server-api.md §Inviting to a room
**Priority:** Resolved for this Complement suite; keep an eye on related downstream suites rather than treating invite flow itself as a current blocker.

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

### D. Invited-room sync is no longer blocked on invite/leave classification

**Tests:** `TestDeviceListsUpdateOverFederation` (4), `TestIsDirectFlagFederation` (1), `TestFederationRoomsInvite`
**Current status:** `invite_state.events` is populated for federation invites, join `unsigned.prev_content` is preserved, and the invite-only leave/reject/rescind `/sync` classification issues uncovered by `TestFederationRoomsInvite` are now fixed.
**Remaining gap:** If `TestDeviceListsUpdateOverFederation` or `TestIsDirectFlagFederation` still fail, they should now be treated as downstream device-list / DM evidence problems rather than the older invite-only membership-classification bug.
**Root cause:** The original `invite_stripped_state` cleanup and leave visibility problem was real, but the targeted federation invite TDD resolved it for the exercised paths.
**Code ref:** `src/matrix/application/sync-service.ts`, federation invite/leave handling
**Spec ref:** client-server-api/\_index.md §Syncing — invite_state
**Priority:** Medium — no longer the primary federation blocker; revisit when rerunning DM/device-list suites.

### E. Unknown endpoints return 404 instead of 405 (5 failures)

**Tests:** `TestUnknownEndpoints`
**Error:** `PATCH /_matrix/media/v3/upload` → 404; spec requires 405 Method Not Allowed when the path is known but the method is not.
**Root cause:** Hono route definitions do not register the path with all methods, so unregistered methods fall through to a 404 catch-all instead of 405.
**Spec ref:** client-server-api/\_index.md §API Standards — Unknown endpoints
**Priority:** Medium — quick fix, affects Complement's unknown-endpoint test suite.

### F. Restricted room state/routing remains mostly local-side now

**Tests:** `TestRestrictedRoomsLocalJoin` (3), `TestRestrictedRoomsLocalJoinInMSC3787Room` (3)
**Error:** `PUT /rooms/:id/state/m.room.join_rules/` → 404 `M_UNRECOGNIZED`
**Current status:** Remote restricted-join suites improved significantly in test9, but local restricted-join coverage still fails on the empty-`state_key` room-state route.
**Root cause:** Route definition in `src/api/rooms.ts` likely requires `:stateKey` to be non-empty. Trailing `/` (empty state_key) is not handled.
**Spec ref:** client-server-api/\_index.md §Room State
**Priority:** Medium — blocks restricted room tests.

### G. Space hierarchy does not reflect redactions (6 failures)

**Tests:** `TestClientSpacesSummary`
**Error:** `/hierarchy` returns child rooms even after `m.space.child` event is redacted.
**Root cause:** `src/api/spaces.ts` hierarchy traversal reads current state without checking redaction status of `m.space.child` events.
**Spec ref:** client-server-api modules/spaces.md
**Priority:** Medium.

### H. Rate limiter triggers during tests (11+ failures)

**Tests:** `TestMSC4289PrivilegedRoomCreators` (12+), others
**Error:** `429 M_LIMIT_EXCEEDED` returned during rapid sequential requests within a single test.
**Root cause:** Rate limiter `RateLimitDurableObject` does not distinguish test environments. Complement hammers endpoints in rapid sequence, hitting limits designed for production.
**Code ref:** `src/durable-objects/RateLimitDurableObject.ts`, middleware
**Priority:** Medium — test environment should disable or relax rate limiting. `MATRIX_FEATURE_PROFILE=core` could gate it.

### I. Unimplemented or out-of-scope (remaining ~100 failures)

Features not yet implemented. Not regressions.

| Category                           | Tests                                                                                                 | Notes                                                                                                                                           |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| To-device over federation          | `TestToDeviceMessagesOverFederation` (4)                                                              | Federation EDU delivery for to-device                                                                                                           |
| Remote presence                    | `TestRemotePresence` (3)                                                                              | Presence EDU federation                                                                                                                         |
| Federation invite full flow        | `TestFederationRoomsInvite` pass                                                                      | Invite, reject, rescind, repeated invite/reject, and already-participating homeserver paths now pass targeted rerun and appear in test9 results |
| Remote join validation             | `TestJoinFederatedRoomWithUnverifiableEvents` (5)                                                     | Unverifiable event rejection                                                                                                                    |
| Auth chain / state resolution      | `TestEventAuth`, `TestCorruptedAuthChain`, `TestInboundFederationRejectsEventsWithRejectedAuthEvents` | Event auth correctness                                                                                                                          |
| Knocking                           | `TestKnocking`, `TestKnockingInMSC3787Room`                                                           | Several subtests started passing in test9, but the suite remains one of the largest failure buckets                                             |
| MSC4289 (Privileged room creators) | 12+                                                                                                   | v12 room feature, not yet implemented                                                                                                           |
| MSC4291 (Room ID as hash)          | 5+                                                                                                    | Experimental room version                                                                                                                       |
| MSC4297 (State resolution v2)      | 2                                                                                                     | State resolution extension                                                                                                                      |
| MSC4311                            | 1                                                                                                     |                                                                                                                                                 |
| Remote media                       | `TestContentMediaV1`, `TestRemotePngThumbnail`                                                        | `media.ts` explicitly returns "not supported"                                                                                                   |
| Spaces federation                  | `TestFederatedClientSpaces`, `TestRestrictedRoomsSpacesSummaryFederation`                             |                                                                                                                                                 |

---

## Fix Priority Summary

| Priority  | Category                                          | Estimated scope                                                     |
| --------- | ------------------------------------------------- | ------------------------------------------------------------------- |
| 🔴 High   | B — send_join event type validation               | `federation.ts` handler check                                       |
| 🔴 High   | C — get_missing_events implementation             | `federation.ts` DAG traversal                                       |
| 🔴 High   | Knocking / knock auth and transitions             | room-version 7/11 knock flow correctness                            |
| 🟡 Medium | Jump-to-date endpoint                             | event lookup / timestamp boundary semantics                         |
| 🟡 Medium | D — downstream DM/device-list federation evidence | rerun targeted suites now that invite/leave classification is fixed |
| 🟡 Medium | E — 405 vs 404 unknown methods                    | Hono route registration                                             |
| 🟡 Medium | F — empty state_key routing                       | `rooms.ts` route pattern                                            |
| 🟡 Medium | G — space hierarchy + redactions                  | `spaces.ts` state filter                                            |
| 🟡 Medium | H — rate limiter in test env                      | Feature profile or env flag                                         |
| ⚪ Later  | I — unimplemented features                        | Scoped per MSC/spec section                                         |
