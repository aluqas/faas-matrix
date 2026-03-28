# Matrix Spec Check v2 Complement Evidence

## Complement Evidence Summary

> Detailed analysis: [`docs/matrix/complement-analysis.md`](./complement-analysis.md)
> Based on Complement test runs test1–test5 (2026-03-27). 200 tests reached, 34 passing (17%).

This section maps Complement results to the spec areas tracked above.
`complement:pass` = at least one subtest passing. `complement:fail` = all subtests failing. `complement:gap` = not yet reached by any test in these runs.

### Client-Server Core — Complement Evidence

| Area | Evidence | Notes | surface_status | behavior_status | evidence_status | row_id |
|------|----------|-------|----------------|-----------------|-----------------|--------|
| API standards | `complement:fail` | Unknown endpoints return 404 instead of 405 (`TestUnknownEndpoints`) | `partial` | `partial` | `complement` | cs-core-api-standards |
| Web browser clients | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `none` | `not-audited` | `none` | cs-core-web-browser-clients |
| Server discovery | `complement:partial` | `TestVersionStructure` covers `/versions`; `.well-known` and auth metadata still need explicit evidence | `present` | `partial` | `complement` | cs-core-server-discovery |
| Client authentication | `complement:partial` | Login/logout/change-password/deactivate/refresh-token flows have csapi tests; registration and login-token coverage still incomplete | `partial` | `partial` | `complement` | cs-core-client-authentication |
| Capabilities negotiation | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `partial` | `partial` | `complement` | cs-core-capabilities-negotiation |
| Filtering | `complement:fail` | `TestSyncOmitsStateChangeOnFilteredEvents` failing | `partial` | `partial` | `complement` | cs-core-filtering |
| Events | `complement:partial` | Basic send/recv passing; size limits pass (`TestEventSizeLimits`) | `partial` | `partial` | `complement` | cs-core-events |
| Rooms | `complement:partial` | Local join/leave/alias passing; restricted rooms partially failing | `partial` | `partial` | `complement` | cs-core-rooms |
| User data | `complement:fail` | `TestWriteMDirectAccountData` → 500; account_data sync incremental failing | `partial` | `partial` | `complement` | cs-core-user-data |
| Support information | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `none` | `not-audited` | `none` | cs-core-support-information |

### Client-Server Modules — Complement Evidence

| Module | Evidence | Notes | surface_status | behavior_status | evidence_status | row_id |
|------|----------|-------|----------------|-----------------|-----------------|--------|
| Content repository | `complement:partial` | Local media passing; remote/federation media explicitly unsupported (`TestContentMediaV1`) | `partial` | `partial` | `complement` | cs-module-content-repository |
| Direct messaging | `complement:partial` | `TestIsDirectFlagLocal` passes; `TestIsDirectFlagFederation` still fails because invited-room sync is missing `invite_state` | `partial` | `partial` | `complement` | cs-module-direct-messaging |
| Ignoring users | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `partial` | `partial` | `complement` | cs-module-ignoring-users |
| Instant messaging | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `partial` | `partial` | `complement` | cs-module-instant-messaging |
| Presence | `complement:fail` | `TestRemotePresence` failing — presence EDU federation not implemented | `partial` | `partial` | `complement` | cs-module-presence |
| Push notifications | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `partial` | `not-audited` | `none` | cs-module-push-notifications |
| Receipts | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `partial` | `partial` | `complement` | cs-module-receipts |
| Room history visibility | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `partial` | `not-audited` | `complement` | cs-module-room-history-visibility |
| Room upgrades | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `partial` | `not-audited` | `none` | cs-module-room-upgrades |
| Third-party invites | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `partial` | `partial` | `complement` | cs-module-third-party-invites |
| Typing notifications | `complement:fail` | `TestRemoteTyping` failing | `partial` | `partial` | `complement` | cs-module-typing-notifications |
| User and room mentions | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `none` | `not-audited` | `none` | cs-module-user-and-room-mentions |
| Voice over IP | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `partial` | `not-audited` | `none` | cs-module-voice-over-ip |
| Client config | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `partial` | `partial` | `complement` | cs-module-client-config |
| Application service adjunct endpoints | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `partial` | `not-audited` | `none` | cs-module-application-service-adjunct-endpoints |
| Device management | `complement:fail` | `TestDeviceListsUpdateOverFederation` — invite_state missing from sync | `partial` | `partial` | `complement` | cs-module-device-management |
| End-to-end encryption | `complement:partial` | Device key upload/query surface exists, but federation device-list propagation is still failing | `partial` | `partial` | `complement` | cs-module-end-to-end-encryption |
| Event annotations and reactions | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `partial` | `not-audited` | `none` | cs-module-event-annotations-and-reactions |
| Event context | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `none` | `not-audited` | `none` | cs-module-event-context |
| Event replacements | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `partial` | `not-audited` | `none` | cs-module-event-replacements |
| Read and unread markers | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `partial` | `partial` | `complement` | cs-module-read-and-unread-markers |
| Guest access | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `none` | `not-audited` | `none` | cs-module-guest-access |
| Moderation policy lists | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `none` | `not-audited` | `none` | cs-module-moderation-policy-lists |
| Policy servers | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `none` | `not-audited` | `none` | cs-module-policy-servers |
| OpenID | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `partial` | `not-audited` | `none` | cs-module-openid |
| Notifications | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `partial` | `partial` | `complement` | cs-module-notifications |
| Old sync and legacy endpoints | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `none` | `not-audited` | `none` | cs-module-old-sync-and-legacy-endpoints |
| Peeking events | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `none` | `not-audited` | `none` | cs-module-peeking-events |
| Recently used emoji | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `none` | `not-audited` | `none` | cs-module-recently-used-emoji |
| Reference relations | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `partial` | `not-audited` | `none` | cs-module-reference-relations |
| Reporting content | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `partial` | `not-audited` | `none` | cs-module-reporting-content |
| Rich replies | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `partial` | `not-audited` | `none` | cs-module-rich-replies |
| Room previews | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `partial` | `partial` | `complement` | cs-module-room-previews |
| Room tagging | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `partial` | `not-audited` | `none` | cs-module-room-tagging |
| SSO client login/authentication | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `partial` | `not-audited` | `none` | cs-module-sso-client-login-authentication |
| Secrets | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `none` | `not-audited` | `none` | cs-module-secrets |
| Send-to-device messaging | `complement:fail` | `TestToDeviceMessagesOverFederation` failing — federation EDU delivery | `partial` | `partial` | `complement` | cs-module-send-to-device-messaging |
| Server ACLs | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `partial` | `not-audited` | `complement` | cs-module-server-access-control-lists-acls-for-rooms |
| Server administration | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `partial` | `partial` | `complement` | cs-module-server-administration |
| Server notices | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `partial` | `partial` | `complement` | cs-module-server-notices |
| Server side search | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `partial` | `partial` | `complement` | cs-module-server-side-search |
| Spaces | `complement:fail` | `/hierarchy` present but `TestClientSpacesSummary` failing on redacted child handling | `partial` | `partial` | `complement` | cs-module-spaces |
| Sticker messages | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `none` | `not-audited` | `none` | cs-module-sticker-messages |
| Third-party networks | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `none` | `not-audited` | `none` | cs-module-third-party-networks |
| Threading | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `partial` | `partial` | `complement` | cs-module-threading |
| Invite permission | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `none` | `not-audited` | `none` | cs-module-invite-permission |

### Server-Server Core — Complement Evidence

| Area | Evidence | Notes | surface_status | behavior_status | evidence_status | row_id |
|------|----------|-------|----------------|-----------------|-----------------|--------|
| API standards | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `partial` | `not-audited` | `complement` | ss-core-api-standards |
| TLS | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `none` | `not-audited` | `none` | ss-subsection-api-standards-tls |
| Unsupported endpoints | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `partial` | `partial` | `complement` | ss-subsection-api-standards-unsupported-endpoints |
| Server discovery | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `partial` | `partial` | `none` | ss-core-server-discovery |
| Authentication | `complement:fail` | `TestInboundFederationKeys` failing; signature verification issues in some flows | `partial` | `partial` | `complement` | ss-core-authentication |
| Request Authentication | `complement:fail` | `TestInboundFederationKeys` failing; signature verification issues in some flows | `partial` | `partial` | `complement` | ss-subsection-authentication-request-authentication |
| Response Authentication | `complement:fail` | `TestInboundFederationKeys` failing; signature verification issues in some flows | `partial` | `partial` | `complement` | ss-subsection-authentication-response-authentication |
| Client TLS Certificates | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `none` | `not-audited` | `none` | ss-subsection-authentication-client-tls-certificates |
| Transactions | `complement:fail` | `TestOutboundFederationSend` / `TestNetworkPartitionOrdering` failing | `partial` | `not-audited` | `complement` | ss-core-transactions |
| PDUs | `complement:fail` | `TestEventAuth`, `TestCorruptedAuthChain`, `TestInboundFederationRejectsEventsWithRejectedAuthEvents` | `partial` | `partial` | `complement` | ss-core-pdus |
| EDUs | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `partial` | `partial` | `complement` | ss-core-edus |
| Room state resolution | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `partial` | `partial` | `complement` | ss-core-room-state-resolution |
| Backfill / missing events | `complement:fail` | `TestInboundCanReturnMissingEvents` — endpoint not returning events | `partial` | `partial` | `complement` | ss-core-backfilling-and-retrieving-missing-events |
| Retrieving events | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `partial` | `partial` | `complement` | ss-core-retrieving-events |
| Joining rooms | `complement:partial` | `TestJoinViaRoomIDAndServerName` now passing; `send_join` validation incomplete | `partial` | `partial` | `complement` | ss-core-joining-rooms |
| Knocking | `complement:fail` | `TestKnocking`, `TestKnockingInMSC3787Room` | `partial` | `partial` | `complement` | ss-core-knocking-upon-a-room |
| Inviting | `complement:fail` | `TestFederationRoomsInvite` — FK constraint on invite insert | `partial` | `partial` | `complement` | ss-core-inviting-to-a-room |
| Leaving rooms | `complement:fail` | `TestCannotSendNonLeaveViaSendLeaveV1/V2` — partial (some subtests pass) | `partial` | `partial` | `complement` | ss-core-leaving-rooms-rejecting-invites |
| Third-party invites | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `partial` | `not-audited` | `none` | ss-core-third-party-invites |
| Published room directory | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `partial` | `partial` | `complement` | ss-core-published-room-directory |
| Spaces | `complement:fail` | `/hierarchy` present but `TestClientSpacesSummary` failing on redacted child handling | `partial` | `partial` | `complement` | ss-core-spaces |
| Typing Notifications | `complement:fail` | `TestRemoteTyping` failing | `partial` | `partial` | `complement` | ss-core-typing-notifications |
| Presence | `complement:fail` | `TestRemotePresence` failing — presence EDU federation not implemented | `partial` | `partial` | `complement` | ss-core-presence |
| Receipts | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `partial` | `not-audited` | `complement` | ss-core-receipts |
| Querying for information | `complement:partial` | `TestInboundFederationProfile` 1/2 subtests pass; `TestOutboundFederationProfile` failing | `partial` | `partial` | `complement` | ss-core-querying-for-information |
| OpenID | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `partial` | `not-audited` | `none` | ss-core-openid |
| Device management | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `partial` | `partial` | `complement` | ss-core-device-management |
| End-to-end encryption | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `partial` | `partial` | `complement` | ss-core-end-to-end-encryption |
| Send-to-device messaging | `complement:fail` | `TestToDeviceMessagesOverFederation` failing — federation EDU delivery | `partial` | `partial` | `complement` | ss-core-send-to-device-messaging |
| Content repository | `complement:fail` | Remote media paths are reached by Complement, but currently return "not supported" | `none` | `not-audited` | `complement` | ss-core-content-repository |
| Server ACLs | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `partial` | `not-audited` | `complement` | ss-core-server-access-control-lists-acls |
| Policy servers | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `none` | `not-audited` | `none` | ss-core-policy-servers |
| Signing events | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `partial` | `not-audited` | `none` | ss-core-signing-events |
| Security considerations | `complement:gap` | Not explicitly covered in complement-analysis.md test runs. | `partial` | `not-audited` | `complement` | ss-core-security-considerations |

## Application Service API — Complement Evidence

> These rows are outside the automated `spec:coverage` pipeline. Complement has no AS-protocol test suite accessible out-of-repo; all rows are `complement:gap` until a Complement AS adapter is wired.

| Area | Evidence | Notes | surface_status | behavior_status | evidence_status | row_id |
|------|----------|-------|----------------|-----------------|-----------------|--------|
| Registration | `complement:gap` | Complement does not exercise the AS registration config flow. | `partial` | `not-audited` | `none` | as-registration |
| HS → AS protocol | `complement:gap` | Complement does not push transactions or queries to an AS in standard out-of-repo runs. | `partial` | `not-audited` | `none` | as-hs-to-as-protocol |
| CS API extensions | `complement:gap` | Identity assertion and timestamp massaging are not exercised by current Complement runs. | `partial` | `not-audited` | `none` | as-cs-api-extensions |
| Third-party networks | `complement:gap` | Third-party network protocol lookups are not covered by Complement. | `none` | `not-audited` | `none` | as-third-party-networks |

## Identity Service API — Complement Evidence

> These rows are outside the automated `spec:coverage` pipeline. Complement does not test the Identity Service API in standard out-of-repo runs.

| Area | Evidence | Notes | surface_status | behavior_status | evidence_status | row_id |
|------|----------|-------|----------------|-----------------|-----------------|--------|
| API standards and authentication | `complement:gap` | Not covered by Complement. | `partial` | `not-audited` | `none` | is-api-standards-and-auth |
| Association lookup | `complement:gap` | Not covered by Complement. | `partial` | `not-audited` | `none` | is-association-lookup |
| Establishing associations | `complement:gap` | Not covered by Complement. | `none` | `not-audited` | `none` | is-establishing-associations |
| Invitation storage and signing | `complement:gap` | Not covered by Complement. | `none` | `not-audited` | `none` | is-invitation-storage-and-signing |

## Push Gateway API — Complement Evidence

> These rows are outside the automated `spec:coverage` pipeline. Complement does not exercise outbound push gateway delivery in standard out-of-repo runs.

| Area | Evidence | Notes | surface_status | behavior_status | evidence_status | row_id |
|------|----------|-------|----------------|-----------------|-----------------|--------|
| Push notification delivery | `complement:gap` | Not covered by Complement. Push delivery correctness requires a mock push gateway listener. | `partial` | `not-audited` | `none` | pg-notify |

## Room Versions — Complement Evidence

> These rows are outside the automated `spec:coverage` pipeline. Complement implicitly exercises room versions through federation and join tests, but per-version algorithm correctness is not directly targeted.

| Version | Evidence | Notes | surface_status | behavior_status | evidence_status | row_id |
|---------|----------|-------|----------------|-----------------|-----------------|--------|
| v1 | `complement:gap` | v1 rooms are legacy; Complement tests do not specifically target v1 state resolution or opaque event IDs. | `partial` | `not-audited` | `none` | rv-v1 |
| v2 | `complement:gap` | Not directly targeted by Complement. | `partial` | `not-audited` | `none` | rv-v2 |
| v3 | `complement:gap` | Not directly targeted by Complement. | `partial` | `not-audited` | `none` | rv-v3 |
| v4 | `complement:gap` | Not directly targeted by Complement. | `partial` | `not-audited` | `none` | rv-v4 |
| v5 | `complement:gap` | Not directly targeted by Complement. | `partial` | `not-audited` | `none` | rv-v5 |
| v6 | `complement:gap` | Not directly targeted by Complement. | `partial` | `not-audited` | `none` | rv-v6 |
| v7 | `complement:gap` | `TestKnocking` exercises knock join rule but tests are currently failing; per-version audit not done. | `partial` | `not-audited` | `none` | rv-v7 |
| v8 | `complement:gap` | Restricted join tests partially failing; per-version audit not done. | `partial` | `not-audited` | `none` | rv-v8 |
| v9 | `complement:gap` | Not directly targeted by Complement. | `partial` | `not-audited` | `none` | rv-v9 |
| v10 | `complement:gap` | Not directly targeted by Complement. | `partial` | `not-audited` | `none` | rv-v10 |
| v11 | `complement:gap` | Not directly targeted by Complement. | `partial` | `not-audited` | `none` | rv-v11 |

