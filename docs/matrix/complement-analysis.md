# Complement Status

Current-state Complement status for this repository.
Last updated: 2026-04-02.

This document is intentionally current-state only. Historical progression and old run-to-run comparisons are out of scope here.

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
- `TestPartialStateJoin`
- `TestMSC4308ThreadSubscriptionsSlidingSync`

Working interpretation:

- remaining issues are in aggregate semantics, not basic route reachability
- likely pressure points are lazy-loaded membership state, incremental sliding-sync merge behavior, and partial-state interaction with top-level projection

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
- `TestPartialStateJoin`

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

1. `TestPartialStateJoin`, `TestSync`, `TestPresence`, `TestMSC4308ThreadSubscriptionsSlidingSync`
2. `TestInboundFederationKeys`, `TestInboundFederationProfile`
3. `TestDeviceListsUpdateOverFederationOnRoomJoin`
4. `TestRoomCreate`, `TestFetchEvent`, `TestDelayedEvents`
5. `TestMSC3757OwnedState`
