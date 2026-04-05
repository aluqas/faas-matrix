# Sync Read Model Re-arch: Targeted Rerun Guide

This document defines the targeted rerun procedure for the stable Red Complement test families
identified in the `sync-read-model-rearch` plan.

## What Changed

| Phase | Change | Files |
|-------|--------|-------|
| 1 | `RoomVisibilityContext` extracted to `contracts.ts`; `buildSlidingSyncVisibilityContext` helper added | `src/matrix/application/features/sync/contracts.ts` |
| 2 | `buildSlidingSyncExtensions()` shared builder; MSC3575 and MSC4186 extension blocks unified | `src/api/sliding-sync-extensions.ts`, `src/api/sliding-sync.ts` |
| 3 | `PresenceProjectionQuery.roomIds` → `visibleRoomIds`; presence now uses `allJoinedRoomIds` in sliding-sync | `src/matrix/application/features/presence/contracts.ts`, `project.ts`, `top-level.ts`, `sliding-sync-extensions.ts` |
| 4 | MSC4308 thread subscriptions fall back to `allJoinedRoomIds` when no explicit room list given | `src/api/sliding-sync-extensions.ts` |
| 5 | `getJoinedRoomIdsIncludingPartialState` + `getEffectiveJoinedMemberCount` in `membership-repository.ts`; cross-reference doc-comment in `database.ts` `getUserRooms` | `src/matrix/repositories/membership-repository.ts`, `src/services/database.ts` |

## Test Families to Rerun

### Priority 1 — `TestPresence`

**Hypothesis**: Presence events for users in rooms outside the sliding-sync window
were being dropped. Phase 3 fix ensures `allJoinedRoomIds` (not `responseRoomIds`) is
the input to `projectPresenceEvents`.

**Run command**:
```bash
COMPLEMENT_FILTER=TestPresence ./run-complement.sh
```

**Pass criteria**:
- `TestPresence/TestPresenceBecomesOnlineAndCanBeSeen` — Green
- `TestPresence/TestPresenceInSlidingSync` — Green (if applicable to test suite)

---

### Priority 2 — `TestSync`

**Hypothesis**: Incremental sync may have missed presence or device-list updates when
users share rooms outside the current response window.

**Run command**:
```bash
COMPLEMENT_FILTER=TestSync ./run-complement.sh
```

**Key sub-tests**:
- `TestSync/TestPresenceSyncGlobal`
- `TestSync/TestPresenceSyncOfflineStopsUpdates`
- `TestSync/TestDeviceListsInSyncResponse`

---

### Priority 3 — `TestMSC4308ThreadSubscriptionsSlidingSync`

**Hypothesis**: Thread subscriptions were only active in MSC4186 path. Phase 2 unification
adds MSC4308 to the shared builder, so both MSC3575 and MSC4186 now serve it consistently.
Phase 4 adds `allJoinedRoomIds` fallback when no explicit room list is requested.

**Run command**:
```bash
COMPLEMENT_FILTER=TestMSC4308ThreadSubscriptionsSlidingSync ./run-complement.sh
```

---

### Priority 4 — `TestPartialStateJoin`

**Hypothesis**: Lazy-load membership and device-list propagation should be consistent
because they both reference the same "effective membership" pattern (UNION of
`room_memberships` + `room_state`).

**Run command**:
```bash
COMPLEMENT_FILTER=TestPartialStateJoin ./run-complement.sh
```

**Key sub-tests**:
- `TestPartialStateJoin/TestLazyLoadMemberships` — depends on `shouldExposePartialStateRoom()`
- `TestPartialStateJoin/TestDeviceListsForRemoteUsers` — depends on device-list UNION CTE

---

## Suggested Order

1. Run `TestPresence` first (highest impact from Phase 3 change).
2. Run `TestSync` to confirm no regression from presence changes.
3. Run `TestMSC4308ThreadSubscriptionsSlidingSync` (Phase 2 + Phase 4 changes).
4. Run `TestPartialStateJoin` to validate Phase 5 partial-state consistency.

## Architecture Reference

```
RoomVisibilityContext (contracts.ts)
  │
  ├── /sync assembler  ←── visibleJoinedRoomIds  ──► presence (visibleRoomIds)
  │   (assembler.ts)                                 (project.ts)
  │
  └── sliding-sync     ←── allJoinedRoomIds      ──► buildSlidingSyncExtensions
      (sliding-sync.ts)                              (sliding-sync-extensions.ts)
                                                         ├── presence (visibleRoomIds)
                                                         ├── typing   (resolveEphemeralRoomIds)
                                                         ├── receipts (resolveEphemeralRoomIds)
                                                         └── MSC4308  (allJoinedRoomIds fallback)

Effective membership fact (membership-repository.ts)
  getJoinedRoomIdsIncludingPartialState()
  │
  ├── Referenced by: database.ts getUserRooms  (room visibility in /sync)
  ├── Referenced by: matrix-repositories.ts getDeviceListChanges  (device-list propagation)
  └── listVisibleUsers in presence-repository.ts  (uses room_state, covers partial-state)
```
