# Complement Status

Current-state Complement status for this repository.
Last updated: 2026-04-09.

This document is intentionally current-state only. Historical progression and old run-to-run comparisons are out of scope here.
For active repair planning and sampled failure signatures from the latest broad rerun, see [`docs/matrix/complement-remediation-plan.md`](./complement-remediation-plan.md).

## Evidence Model

Use two Complement views:

- `stable full-run baseline`
  - broad aggregate run used for docs and spec evidence
  - should be readable without startup/deploy noise dominating the result
- `deep diagnostic run`
  - broad aggregate run with relaxed package timeout to expose more buckets
  - useful for reach and triage, but not the baseline when classification is mixed

Per-run artifacts:

- raw log: `logs/<ts>.log`
- docker log: `logs/<ts>.docker.log`
- compact summary: `logs/<ts>.summary.json`
- failure classifier: `logs/<ts>.classified.json`

Evidence policy:

- clean targeted green is positive implementation evidence
- stable aggregate red is implementation evidence when classification is `implementation_fail`
- mixed diagnostic red is a backlog signal until reproduced cleanly
- startup/deploy and infra buckets are tracked separately from implementation gaps

## Stable Full-Run Baseline

Artifacts:

- raw log: [`2026-04-02_04-32-47-8585.log`](/Users/saqula/Documents/02_codes/github.com/aluqas/faas-matrix/logs/2026-04-02_04-32-47-8585.log)
- summary: [`2026-04-02_04-32-47-8585.summary.json`](/Users/saqula/Documents/02_codes/github.com/aluqas/faas-matrix/logs/2026-04-02_04-32-47-8585.summary.json)
- classified: [`2026-04-02_04-32-47-8585.classified.json`](/Users/saqula/Documents/02_codes/github.com/aluqas/faas-matrix/logs/2026-04-02_04-32-47-8585.classified.json)

Result:

- top-level summary: `50 total / 37 pass / 11 fail / 2 skip`
- analyzer depth-7 parse: `248 reached / 203 pass / 38 fail / 7 skip`
- overall classification: `implementation_fail`

Interpretation:

- this is the current docs/spec baseline
- this run did not end up dominated by startup/deploy flake
- remaining red buckets are implementation work, not harness noise

## Deep Diagnostic Run

Artifacts:

- raw log: [`2026-04-02_05-29-07-70996.log`](/Users/saqula/Documents/02_codes/github.com/aluqas/faas-matrix/logs/2026-04-02_05-29-07-70996.log)
- summary: [`2026-04-02_05-29-07-70996.summary.json`](/Users/saqula/Documents/02_codes/github.com/aluqas/faas-matrix/logs/2026-04-02_05-29-07-70996.summary.json)
- classified: [`2026-04-02_05-29-07-70996.classified.json`](/Users/saqula/Documents/02_codes/github.com/aluqas/faas-matrix/logs/2026-04-02_05-29-07-70996.classified.json)

Result:

- top-level summary: `207 total / 118 pass / 87 fail / 2 skip`
- analyzer depth-7 parse: `795 reached / 526 pass / 249 fail / 20 skip`
- overall classification: `mixed`

Interpretation:

- this run exists because the default `go test` package timeout was clipping reach
- it is useful for discovering deeper implementation buckets
- it is not the stable baseline because startup/deploy and infra noise reappear

What it proved:

- the lower reach in the stable run was materially affected by package timeout
- there is substantially more exercised surface behind the current stable baseline
- some remaining failures are only visible once packages are allowed to run much longer

## Latest Broad Mixed Rerun

### 2026-04-09 (current)

Artifacts:

- raw log: [`2026-04-09_05-34-24-93047.log`](/Users/saqula/Documents/02_codes/github.com/aluqas/faas-matrix/logs/2026-04-09_05-34-24-93047.log)
- summary: [`2026-04-09_05-34-24-93047.summary.json`](/Users/saqula/Documents/02_codes/github.com/aluqas/faas-matrix/logs/2026-04-09_05-34-24-93047.summary.json)
- classified: [`2026-04-09_05-34-24-93047.classified.json`](/Users/saqula/Documents/02_codes/github.com/aluqas/faas-matrix/logs/2026-04-09_05-34-24-93047.classified.json)

Result:

- top-level summary: `207 total / 114 pass / 91 fail / 2 skip` (55%)
- overall classification: `mixed`

Delta vs 2026-04-05: **−15 pass, +15 fail**

Regressions (tests that were green evidence, now red in this run):

- `TestACLs`, `TestEventAuth`, `TestGetMissingEventsGapFilling`, `TestInboundCanReturnMissingEvents`
- `TestInviteFiltering`, `TestRemoteTyping`, `TestSyncOmitsStateChangeOnFilteredEvents`
- `TestUnbanViaInvite`, `TestUnknownEndpoints`

Previously diagnostic-only buckets now reaching stable baseline:

- `TestRestrictedRooms*`, `TestKnocking*`, `TestMSC4289PrivilegedRoomCreators*`
- `TestMSC4291RoomIDAsHashOfCreateEvent*`, `TestMSC4297StateResolutionV2_1*`
- `TestRoomMessagesLazyLoading*`, `TestMessagesOverFederation`, `TestFederationRoomsInvite`
- `TestFederationKeyUploadQuery`, `TestUploadKey`, `TestE2EKeyBackupReplaceRoomKeyRules`
- `TestKeyChangesLocal`, `TestRoomSpecificUsername*`, `TestPublicRooms`, `TestRoomSummary`
- `TestJumpToDateEndpoint`, `TestArchivedRoomsHistory`, `TestAsyncUpload`
- `TestRoomImageRoundtrip`, `TestMediaWithoutFileName`, `TestUrlPreview`

New tests not in previous runs (spec v1.17 / newer Complement):

- `TestComplementCanCreateValidV12Rooms`, `TestMSC4311FullCreateEventOnStrippedState`
- `TestEventRelationships`, `TestFederatedEventRelationships`
- `TestTxnIdempotency`, `TestTxnIdempotencyScopedToDevice`, `TestTxnScopeOnLocalEcho`

infra_flake in this run: `TestPartialStateJoin` (parent, transport_skew), `TestFederationThumbnail` (transport_skew)

Interpretation:

- the regression from types-contract hardening (2026-04-09 refactor) has surfaced previously-silent issues at runtime
- this run is now the working baseline for triage; the 2026-04-05 run is no longer current
- sampled concrete failures and the remediation plan now live in [`docs/matrix/complement-remediation-plan.md`](./complement-remediation-plan.md)
- broad rerun regressions do not automatically invalidate targeted green evidence, but they do mean those areas are not yet aggregate-stable

### 2026-04-05 (previous)

Artifacts:

- raw log: [`2026-04-05_07-56-40-49151.log`](/Users/saqula/Documents/02_codes/github.com/aluqas/faas-matrix/logs/2026-04-05_07-56-40-49151.log)
- summary: [`2026-04-05_07-56-40-49151.summary.json`](/Users/saqula/Documents/02_codes/github.com/aluqas/faas-matrix/logs/2026-04-05_07-56-40-49151.summary.json)
- classified: [`2026-04-05_07-56-40-49151.classified.json`](/Users/saqula/Documents/02_codes/github.com/aluqas/faas-matrix/logs/2026-04-05_07-56-40-49151.classified.json)

Result:

- top-level summary: `207 total / 129 pass / 76 fail / 2 skip` (62%)
- overall classification: `mixed`

## Current Green Evidence

These are currently green in either the stable full-run baseline or clean targeted reruns and should be treated as positive evidence:

- federation EDU / transaction hot paths
  - `TestACLs`
  - `TestOutboundFederationProfile`
  - `TestRemotePresence`
  - `TestRemoteTyping`
  - `TestToDeviceMessagesOverFederation`
  - `TestInboundCanReturnMissingEvents`
  - `TestGetMissingEventsGapFilling`
  - `TestEventAuth`
- sync / filtering / device-list hot paths
  - `TestSyncOmitsStateChangeOnFilteredEvents`
  - `TestDeviceManagement`
  - `TestDeviceListsUpdateOverFederation`
  - `TestUserAppearsInChangedDeviceListOnJoinOverFederation`
  - `TestInviteFiltering`
- room and client-surface correctness
  - `TestUnknownEndpoints`
  - `TestServerCapabilities`
  - `TestRoomAlias`
  - `TestRoomDeleteAlias`
  - `TestRoomCanonicalAlias`
  - `TestRoomState`
  - `TestRoomForget`
  - `TestRoomMembers`
  - `TestUnbanViaInvite`
- partial state join (MSC3902) core state correctness
  - `TestPartialStateJoin/State_accepted_incorrectly` (2026-04-05 targeted rerun: deferred auth events that passed auth incorrectly are now correctly rejected after resync)
  - `TestPartialStateJoin/State_rejected_incorrectly` (2026-04-05 targeted rerun: deferred auth events that passed auth are now correctly retained in room_state after resync)
  - `TestPartialStateJoin/Rejected_events_remain_rejected_after_resync`
  - `TestPartialStateJoin/CanReceiveEventsDuringPartialStateJoin`
  - `TestPartialStateJoin/CanFastJoinDuringPartialStateJoin`
  - `TestPartialStateJoin/EagerIncrementalSyncDuringPartialStateJoin`
  - `TestPartialStateJoin/EagerInitialSyncDuringPartialStateJoin`
  - `TestPartialStateJoin/EagerLongPollingSyncWokenWhenResyncCompletes`
  - `TestPartialStateJoin/GappySyncAfterPartialStateSynced`
  - `TestPartialStateJoin/Leave_during_resync` subtests (kick, does-not-wait, is-seen-after, rejoin, second-join)
- auth and account lifecycle
  - `TestLogin`
  - `TestLogout`
  - `TestRegistration`
  - `TestChangePassword`
  - `TestChangePasswordPushers`
  - `TestDeactivateAccount`
  - `TestTxnIdWithRefreshToken`
  - `TestWriteMDirectAccountData`
  - `TestRemovingAccountData`
- media, spaces, threading, and related client behavior
  - `TestContentMediaV1`
  - `TestContentCSAPIMediaV1`
  - `TestSearch` in targeted reruns
  - `TestClientSpacesSummary`
  - `TestClientSpacesSummaryJoinRules`
  - `TestFederatedClientSpaces`
  - `TestThreadSubscriptions`

## Stable Failure Buckets

These are the implementation buckets still red in the stable full-run baseline.

### 1. Sync aggregate residuals

- `TestSync`
- `TestPresence`
- `TestMSC4308ThreadSubscriptionsSlidingSync`
- `TestPartialStateJoin` sub-tests: lazy-loading sync membership, `MembersRequestBlocksDuringPartialStateJoin`, `joined_members_blocks_during_partial_state_join`, `CanReceiveTypingDuringPartialStateJoin`, device-list propagation sub-tests, `PartialStateJoinContinuesAfterRestart`, `PartialStateJoinSyncsUsingOtherHomeservers`

Working interpretation:

- remaining issues are in aggregate semantics, not basic route reachability
- likely pressure points are lazy-loaded membership state, incremental sliding-sync merge behavior, and partial-state interaction with top-level projection
- the core partial-state auth correctness (`State_rejected_incorrectly`, `State_accepted_incorrectly`) is now resolved as of 2026-04-05

### 2. Federation query/auth residuals

- `TestInboundFederationKeys`
- `TestInboundFederationProfile`

Working interpretation:

- core transaction and auth paths are healthier than before
- the remaining red area is query/auth edge behavior, especially key/profile handling rather than baseline `/send` correctness

### 3. Device-list propagation on room join

- `TestDeviceListsUpdateOverFederationOnRoomJoin`

Working interpretation:

- broad device-list propagation is mostly green
- the residual bug is specifically the room-join propagation case

### 4. Room/event semantics

- `TestRoomCreate`
- `TestFetchEvent`
- `TestDelayedEvents`

Working interpretation:

- room create still has topic/rich-topic/state representation mismatch
- event retrieval and delayed-event behavior are still not fully aligned with Complement expectations

### 5. MSC-specific bucket

- `TestMSC3757OwnedState`

Working interpretation:

- this remains isolated enough to keep separate from the generic sync/federation buckets

## Diagnostic-Only Expansion Buckets

The 60m diagnostic run surfaced broader red areas that are not yet part of the stable baseline.

### Room versions / restricted rooms / creator rules

- `TestMSC4289PrivilegedRoomCreators*`
- `TestMSC4291RoomIDAsHashOfCreateEvent*`
- `TestMSC4297StateResolutionV2_1*`
- `TestRestrictedRooms*`
- `TestKnockRoomsInPublicRoomsDirectory*`

### Sync, filters, and room timeline semantics

- `TestFilter`
- `TestJson`
- `TestEvent`
- `TestSyncTimelineGap`
- `TestRoomMessagesLazyLoading*`
- `TestOlderLeftRoomsNotInLeaveSection`

### Federation residuals outside the stable baseline

- `TestFederationRoomsInvite`
- `TestInboundCanReturnMissingEvents`
- `TestOutboundFederationIgnoresMissingEventWithBadJSONForRoomVersion6`
- `TestMessagesOverFederation`
- `TestFederationKeyUploadQuery`

### Client config, devices, and push

- `TestPollsLocalPushRules`
- `TestPushSync`
- `TestUploadKey`
- `TestE2EKeyBackupReplaceRoomKeyRules`
- `TestKeyChangesLocal`

### Search, usernames, public room surfaces

- `TestSearch`
- `TestRoomSpecificUsernameAtJoin`
- `TestRoomSpecificUsernameChange`
- `TestPublicRooms`
- `TestRoomSummary`
- `TestJumpToDateEndpoint`
- `TestArchivedRoomsHistory`

### Media and async upload surfaces

- `TestAsyncUpload`
- `TestRoomImageRoundtrip`
- `TestMediaWithoutFileName`
- `TestUrlPreview`

These buckets are real work candidates, but they should not automatically be treated as baseline regressions until reproduced cleanly outside mixed-run noise.

## Flake Backlog

Current flake backlog should be read from the 60m diagnostic run, not the stable baseline.

### Startup/deploy flake

- `TestChangePassword`
- `TestMSC3757OwnedState`
- `TestMSC3967`
- `TestPollsLocalPushRules`

### Infra / transport skew

- `TestFederationThumbnail`
- `TestMSC4297StateResolutionV2_1_starts_from_empty_set`
- `TestMSC4297StateResolutionV2_1_includes_conflicted_subgraph`
- `TestPartialStateJoin` (parent test classified as `infra_flake` due to "Network connection lost" during federation sends; individual sub-tests pass or fail independently — see targeted reruns for per-sub-test evidence)

Working interpretation:

- startup stability is materially better than before, but not fully eliminated in broad diagnostic runs
- mixed federation/media transport issues still exist and can pollute very deep aggregate runs

## Operational Guidance

Use these rules when reading Complement results:

1. docs and spec evidence should be updated from the stable full-run baseline plus clean targeted reruns
2. the 60m run is for finding hidden buckets, not for baseline pass-rate claims
3. if a bucket is red only in the 60m mixed run, reproduce it targeted before treating it as a current regression
4. if a bucket is red in the stable baseline, it is active implementation work

## Current Priority Order

1. `TestSync`, `TestPresence`, `TestMSC4308ThreadSubscriptionsSlidingSync`
2. `TestPartialStateJoin` remaining sub-tests: lazy-loading membership sync, `MembersRequestBlocksDuringPartialStateJoin`, `PartialStateJoinContinuesAfterRestart`, `PartialStateJoinSyncsUsingOtherHomeservers`, device-list propagation
3. `TestInboundFederationKeys`, `TestInboundFederationProfile`
4. `TestDeviceListsUpdateOverFederationOnRoomJoin`
5. `TestRoomCreate`, `TestFetchEvent`, `TestDelayedEvents`
6. `TestMSC3757OwnedState`
