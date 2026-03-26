# Matrix Spec Check v2

This document is a more granular replacement candidate for `docs/matrix/speccheck-matrix.md`.
The goal is to track Matrix compatibility against the specification at the level of spec sections and modules, rather than broad feature buckets.

This is intentionally stricter than the current v1 checklist:

- `surface` means there is an obvious route, module, or service in the repo.
- `behavior` means the implementation has been checked against the spec semantics.
- `evidence` means tests or interop runs exist and are documented.

## Status Legend

各レコードの実装状況を以下の3つの観点から追跡します：

- **`surface_status`**（エンドポイントや仕様）
  - `present`: ルートやサービスが存在し、一通りの実装がある
  - `partial`: 一部のエンドポイントや機能のみ実装されている
  - `none`: 未実装

- **`behavior_status`**（セキュリティ面や実装の妥当性、バグなど含む）
  - `audited`: 仕様・セキュリティ・エッジケースについて検証済みで問題ない
  - `partial`: 基本的な動作はするが、バグが残っている・未検証のケースがある
  - `not-audited`: 実装はあるが動作やセキュリティの妥当性が未検証

- **`evidence_status`**（チェックリストとしての妥当性およびここまでのstatusに対する根拠）
  - `tests`: ユニットテストや回帰テストが実装されている
  - `interop`: 他クライアント・サーバーとの相互接続性が確認されている
  - `complement`: Complementテストにより網羅的に証明されている
  - `none`: 客観的な証拠（テストや検証ログ）がない

The intent is to stop treating `route exists` as equivalent to `spec implemented`.

Automation note:

- `spec:coverage` reads only the three primary checklist sections below.
- `Cross-Cutting Evidence Rows` and `Complement Evidence Summary` are evidence/reporting sections, not coverage targets.
- `docs/matrix/speccheck-matrix-v2-endpoint.md` is a “導線” view generated from OpenAPI operation mappings, and is not a coverage target.
- `row_id` is the stable machine identifier. Display labels may change without breaking coverage as long as `row_id` stays stable.

## Client-Server Core

| Area | Current repo surface | What v2 should track | surface_status | behavior_status | evidence_status | row_id |
|------|----------------------|----------------------|----------------|-----------------|-----------------|--------|
| API standards | `src/index.ts`, middleware, error utilities | Standard error response, content types, JSON shape, transaction identifiers | `present` | `partial` | `complement` | `cs-core-api-standards` |
| Web browser clients | no explicit tracking | Browser-specific access token handling and discovery expectations | `none` | `not-audited` | `none` | `cs-core-web-browser-clients` |
| Server discovery | `src/index.ts`, `src/api/versions.ts` | `/.well-known`, versions, auth metadata, capability exposure | `present` | `partial` | `complement` | `cs-core-server-discovery` |
| Client authentication | `src/api/login.ts`, `src/api/oauth.ts`, `src/api/oidc-auth.ts`, `src/api/qr-login.ts`, `src/middleware/auth.ts` | Registration, login, access-token semantics, refresh, soft logout, account management, legacy API, OAuth 2.0 API | `partial` | `partial` | `complement` | `cs-core-client-authentication` |
| Capabilities negotiation | route surface likely present via versions/capabilities logic | Individual capabilities, advertised values, and alignment with actual behavior | `partial` | `partial` | `complement` | `cs-core-capabilities-negotiation` |
| Filtering | `src/api/sync.ts`, `src/api/sliding-sync.ts`, persistence in services/DB | Filter create/load/apply semantics, lazy-loaded members | `partial` | `partial` | `complement` | `cs-core-filtering` |
| Events | `src/api/rooms.ts`, `src/api/relations.ts`, `src/api/sync.ts` | Event format, size limits, event context, relations, sync semantics, timeline semantics | `partial` | `partial` | `complement` | `cs-core-events` |
| Rooms | `src/api/rooms.ts`, `src/api/aliases.ts`, `src/api/spaces.ts` | Creation, aliases, permissions, membership, public room directory, summaries | `partial` | `partial` | `complement` | `cs-core-rooms` |
| User data | `src/api/profile.ts`, `src/api/account-data.ts`, `src/api/tags.ts`, `src/api/search.ts` | User directory, profiles, account data rules | `partial` | `partial` | `complement` | `cs-core-user-data` |
| Support information | no explicit tracking | Support endpoint surface and published support metadata | `none` | `not-audited` | `none` | `cs-core-support-information` |

## Client-Server Modules

| Module | Current repo surface | Gaps to track explicitly in v2 | surface_status | behavior_status | evidence_status | row_id |
|--------|----------------------|--------------------------------|----------------|-----------------|-----------------|--------|
| Content repository | `src/api/media.ts` | `mxc://` semantics, thumbnails, auth media, federation media interplay | `partial` | `partial` | `complement` | `cs-module-content-repository` |
| Direct messaging | no dedicated `dm` module; room/account-data surface exists | `m.direct` behavior, client/server behavior | `partial` | `not-audited` | `complement` | `cs-module-direct-messaging` |
| Ignoring users | account-data and sync handling exist, but no dedicated route/module | `m.ignored_user_list`, sync filtering rules, invite suppression | `partial` | `partial` | `complement` | `cs-module-ignoring-users` |
| Instant messaging | `src/api/rooms.ts` | msgtypes, message event details, fallback behavior | `partial` | `partial` | `complement` | `cs-module-instant-messaging` |
| Presence | `src/api/presence.ts` | presence EDUs, last active, capability alignment | `partial` | `partial` | `complement` | `cs-module-presence` |
| Push notifications | `src/api/push.ts`, `src/services/push-rule-evaluator.ts` | push rules correctness, mention rules, pusher semantics | `partial` | `not-audited` | `none` | `cs-module-push-notifications` |
| Receipts | `src/api/receipts.ts` | threaded receipts, private receipts, batching semantics | `partial` | `partial` | `complement` | `cs-module-receipts` |
| Room history visibility | no explicit module; likely in room logic | visibility semantics per membership and guest access | `partial` | `not-audited` | `complement` | `cs-module-room-history-visibility` |
| Room upgrades | `src/api/rooms.ts` | tombstones, predecessor/successor semantics | `partial` | `not-audited` | `none` | `cs-module-room-upgrades` |
| Third-party invites | `src/api/federation.ts`, room invite logic | client and federation sides, invite state correctness | `partial` | `partial` | `complement` | `cs-module-third-party-invites` |
| Typing notifications | `src/api/typing.ts` | security considerations, timeout behavior | `partial` | `partial` | `complement` | `cs-module-typing-notifications` |
| User and room mentions | no dedicated route/module; push/events surface exists | `m.mentions`, encrypted-event handling, push integration | `none` | `not-audited` | `none` | `cs-module-user-and-room-mentions` |
| Voice over IP | `src/api/voip.ts`, `src/api/calls.ts`, `src/api/rtc.ts` | call event semantics, party identifiers, interoperability scope | `partial` | `not-audited` | `none` | `cs-module-voice-over-ip` |
| Client config | `src/api/account-data.ts` | full account-data semantics including reserved event types | `partial` | `partial` | `complement` | `cs-module-client-config` |
| Application service adjunct endpoints | `src/api/appservice.ts` | appservice-related client-server auxiliary endpoints and compatibility scope | `partial` | `not-audited` | `none` | `cs-module-application-service-adjunct-endpoints` |
| Device management | `src/api/devices.ts`, login/auth/device binding logic | device lifecycle, delete/update semantics, security considerations | `partial` | `partial` | `complement` | `cs-module-device-management` |
| End-to-end encryption | `src/api/keys.ts`, `src/api/key-backups.ts`, `src/api/to-device.ts`, `src/durable-objects/UserKeysDurableObject.ts` | device keys, cross-signing, secret storage, verification, backup, device list updates | `partial` | `partial` | `complement` | `cs-module-end-to-end-encryption` |
| Event annotations and reactions | `src/api/relations.ts` | aggregation semantics, ignored-user behavior | `partial` | `not-audited` | `none` | `cs-module-event-annotations-and-reactions` |
| Event context | no obvious dedicated route/module | event context endpoint and semantics | `none` | `not-audited` | `none` | `cs-module-event-context` |
| Event replacements | `src/api/relations.ts`, event send logic | edits, `m.new_content`, encrypted edit behavior, mentions interaction | `partial` | `not-audited` | `none` | `cs-module-event-replacements` |
| Read and unread markers | partial via receipts/account-data/sync | fully-read markers, unread markers, client/server behavior | `partial` | `partial` | `complement` | `cs-module-read-and-unread-markers` |
| Guest access | no obvious dedicated module | guest registration, guest tokens, guest room access rules | `none` | `not-audited` | `none` | `cs-module-guest-access` |
| Moderation policy lists | no obvious dedicated module | policy list events and client behavior | `none` | `not-audited` | `none` | `cs-module-moderation-policy-lists` |
| Policy servers | no obvious dedicated module | currently missing from both docs; impacts federation and event validation | `none` | `not-audited` | `none` | `cs-module-policy-servers` |
| OpenID | likely federation OpenID only; no clear client-server row | client OpenID token issuance and usage | `partial` | `not-audited` | `none` | `cs-module-openid` |
| Notifications | partial via sync/push surface | notifications endpoint semantics and unread/notification count alignment | `partial` | `partial` | `complement` | `cs-module-notifications` |
| Old sync and legacy endpoints | no explicit tracking | legacy sync and room initial sync semantics, if exposed | `none` | `not-audited` | `none` | `cs-module-old-sync-and-legacy-endpoints` |
| Peeking events | no explicit tracking | peek/event stream semantics and compatibility stance | `none` | `not-audited` | `none` | `cs-module-peeking-events` |
| Recently used emoji | no obvious dedicated module | account-data behavior | `none` | `not-audited` | `none` | `cs-module-recently-used-emoji` |
| Reference relations | `src/api/relations.ts` | server-side aggregation correctness | `partial` | `not-audited` | `none` | `cs-module-reference-relations` |
| Reporting content | `src/api/report.ts` | report semantics, server behavior | `partial` | `not-audited` | `none` | `cs-module-reporting-content` |
| Rich replies | `src/api/relations.ts`, room send logic | reply fallback/body formatting semantics | `partial` | `not-audited` | `none` | `cs-module-rich-replies` |
| Room previews | room summary surface present | preview semantics and security considerations | `partial` | `partial` | `complement` | `cs-module-room-previews` |
| Room tagging | `src/api/tags.ts` | account-data behavior and sync implications | `partial` | `not-audited` | `none` | `cs-module-room-tagging` |
| SSO client login/authentication | `src/api/oidc-auth.ts`, `src/api/oauth.ts` | SSO login semantics distinct from generic OAuth | `partial` | `not-audited` | `none` | `cs-module-sso-client-login-authentication` |
| Secrets | no dedicated route/module; implied by E2EE ambition | SSSS and secret-sharing need explicit tracking | `none` | `not-audited` | `none` | `cs-module-secrets` |
| Send-to-device messaging | `src/api/to-device.ts` | batching, delivery semantics, device targeting | `partial` | `partial` | `complement` | `cs-module-send-to-device-messaging` |
| Server ACLs | ACL handling is implicit in room-state / federation logic rather than a dedicated route | ACL state handling and federation impact | `partial` | `not-audited` | `complement` | `cs-module-server-access-control-lists-acls-for-rooms` |
| Server administration | `src/api/admin.ts` | admin API scope should be tracked separately from Matrix core | `partial` | `partial` | `complement` | `cs-module-server-administration` |
| Server notices | `src/api/server-notices.ts` | room semantics and client impact | `partial` | `partial` | `complement` | `cs-module-server-notices` |
| Server side search | `src/api/search.ts` | search categories, pagination, ranking/scope limits | `partial` | `partial` | `complement` | `cs-module-server-side-search` |
| Spaces | `src/api/spaces.ts` | hierarchy semantics and federation interplay | `partial` | `partial` | `complement` | `cs-module-spaces` |
| Sticker messages | no obvious dedicated module | sticker event semantics | `none` | `not-audited` | `none` | `cs-module-sticker-messages` |
| Third-party networks | no obvious dedicated module | third-party protocol/network lookups | `none` | `not-audited` | `none` | `cs-module-third-party-networks` |
| Threading | `src/api/relations.ts`, `src/api/receipts.ts`, sync logic | thread listing, aggregation, receipts, notification counts | `partial` | `partial` | `complement` | `cs-module-threading` |
| Invite permission | no explicit dedicated module | room/account-data behavior and client semantics | `none` | `not-audited` | `none` | `cs-module-invite-permission` |

## Server-Server Core

| Area | Current repo surface | What v2 should track | surface_status | behavior_status | evidence_status | row_id |
|------|----------------------|----------------------|----------------|-----------------|-----------------|--------|
| API standards | `src/api/federation.ts` | JSON request/response shape, UTF-8, unsupported endpoint behavior | `partial` | `not-audited` | `complement` | `ss-core-api-standards` |
| TLS | no explicit tracking in current docs | certificate rules, SNI expectations, test-mode allowances | `none` | `not-audited` | `none` | `ss-subsection-api-standards-tls` |
| Unsupported endpoints | no explicit tracking | `404/405 M_UNRECOGNIZED` behavior | `partial` | `partial` | `complement` | `ss-subsection-api-standards-unsupported-endpoints` |
| Server discovery | `src/services/server-discovery.ts`, federation routes | `.well-known`, SRV, delegated names, cache policy | `partial` | `partial` | `none` | `ss-core-server-discovery` |
| Authentication | `src/middleware/federation-auth.ts`, `src/services/federation-keys.ts`, crypto utils | request/response authentication and client TLS certificate assumptions | `partial` | `partial` | `complement` | `ss-core-authentication` |
| Request Authentication | `src/middleware/federation-auth.ts`, `src/services/federation-keys.ts`, crypto utils | request auth semantics, verification inputs, and failure-mode mapping | `partial` | `partial` | `complement` | `ss-subsection-authentication-request-authentication` |
| Response Authentication | `src/middleware/federation-auth.ts`, `src/services/federation-keys.ts`, crypto utils | response auth semantics, signature verification, and response failure handling | `partial` | `partial` | `complement` | `ss-subsection-authentication-response-authentication` |
| Client TLS Certificates | `src/middleware/federation-auth.ts` | certificate rules, SNI expectations, and client certificate assumptions | `none` | `not-audited` | `none` | `ss-subsection-authentication-client-tls-certificates` |
| Transactions | `src/api/federation.ts`, `src/services/transactions.ts` | transaction size limits, idempotency, retry semantics | `partial` | `not-audited` | `complement` | `ss-core-transactions` |
| PDUs | `src/api/federation.ts`, `src/services/event-auth.ts`, `src/services/state-resolution*.ts` | receipt checks, reject vs soft-fail, room-version-sensitive validation | `partial` | `partial` | `complement` | `ss-core-pdus` |
| EDUs | `src/api/federation.ts`, sync/presence/push surfaces | EDU-specific semantics and delivery guarantees | `partial` | `partial` | `complement` | `ss-core-edus` |
| Room state resolution | `src/services/state-resolution.ts`, `src/services/state-resolution-v1.ts` | room-version-specific state resolution, not generic one-size-fits-all | `partial` | `partial` | `complement` | `ss-core-room-state-resolution` |
| Backfill / missing events | `src/api/federation.ts` | bounds, validation, ordering, persistence safety | `partial` | `not-audited` | `complement` | `ss-core-backfilling-and-retrieving-missing-events` |
| Retrieving events | `src/api/federation.ts` | single event, state, state IDs, event auth | `partial` | `partial` | `complement` | `ss-core-retrieving-events` |
| Joining rooms | `src/api/federation.ts`, `src/workflows/RoomJoinWorkflow.ts` | complete handshake semantics, template checks, state/auth_chain correctness | `partial` | `partial` | `complement` | `ss-core-joining-rooms` |
| Knocking | `src/api/federation.ts` | full handshake, retraction/leaving semantics | `partial` | `not-audited` | `complement` | `ss-core-knocking-upon-a-room` |
| Inviting | `src/api/federation.ts` | v1/v2 invites, `invite_room_state`, room-version formatting | `partial` | `partial` | `complement` | `ss-core-inviting-to-a-room` |
| Leaving rooms | `src/api/federation.ts` | invite rejection and knock retraction semantics | `partial` | `partial` | `complement` | `ss-core-leaving-rooms-rejecting-invites` |
| Third-party invites | `src/api/federation.ts` | identity-service-linked flow correctness | `partial` | `not-audited` | `none` | `ss-core-third-party-invites` |
| Published room directory | `src/api/federation.ts`, alias/rooms APIs | federation search/list semantics | `partial` | `partial` | `complement` | `ss-core-published-room-directory` |
| Spaces | `src/api/federation.ts`, `src/api/spaces.ts` | federation hierarchy behavior | `partial` | `partial` | `complement` | `ss-core-spaces` |
| Typing Notifications | `src/api/typing.ts`, `src/api/federation.ts` | typing EDU semantics, batching, and timeout behavior | `partial` | `not-audited` | `complement` | `ss-core-typing-notifications` |
| Presence | `src/api/presence.ts`, `src/api/federation.ts` | presence EDUs, last active semantics, and capability alignment | `partial` | `not-audited` | `complement` | `ss-core-presence` |
| Receipts | `src/api/receipts.ts`, `src/api/federation.ts` | read/unread receipt semantics, threaded/private receipts, and batching | `partial` | `not-audited` | `complement` | `ss-core-receipts` |
| Querying for information | `src/api/federation.ts` | directory/profile/user/device queries | `partial` | `partial` | `complement` | `ss-core-querying-for-information` |
| OpenID | `src/api/federation.ts` | federation OpenID validation | `partial` | `not-audited` | `none` | `ss-core-openid` |
| Device management | `src/api/federation.ts`, `src/api/devices.ts` | user devices over federation | `partial` | `partial` | `complement` | `ss-core-device-management` |
| End-to-end encryption | `src/api/federation.ts`, `src/api/keys.ts` | device-key query, claim, cross-server key handling | `partial` | `partial` | `complement` | `ss-core-end-to-end-encryption` |
| Send-to-device messaging | partial via client API and federation surface | remote to-device semantics | `partial` | `partial` | `complement` | `ss-core-send-to-device-messaging` |
| Content repository | `src/api/federation.ts`, `src/api/media.ts` | media download/thumbnail federation semantics | `none` | `not-audited` | `complement` | `ss-core-content-repository` |
| Server ACLs | no explicit tracking | ACL enforcement against federation | `partial` | `not-audited` | `complement` | `ss-core-server-access-control-lists-acls` |
| Policy servers | no explicit tracking | policy-server enablement and signature validation | `none` | `not-audited` | `none` | `ss-core-policy-servers` |
| Signing events | crypto utils and federation code | content hash, reference hash, signature generation and verification | `partial` | `not-audited` | `none` | `ss-core-signing-events` |
| Security considerations | spread across middleware/services | explicit threat-model and failure-mode checklist | `partial` | `not-audited` | `complement` | `ss-core-security-considerations` |

## Cross-Cutting Evidence Rows

These are not separate spec chapters, but v2 should track them explicitly for every area above.

| Evidence type | What to record |
|---------------|----------------|
| Unit coverage | Which spec rule or algorithm is directly unit tested |
| Route coverage | Which HTTP endpoints have regression tests |
| Complement coverage | Which Complement tests pass, fail, or are not yet wired |
| Client interop | Which client versions have been verified and on what date |
| Federation interop | Which remote homeservers and which flows have been exercised |
| Room-version coverage | Which room versions are supported, tested, and defaulted |

## Immediate Gaps Relative To Current v1 Docs

The current `docs/matrix/speccheck-matrix.md` should be considered incomplete until at least the following are broken out:

1. Split `Authentication` into registration, login, tokens, refresh, soft logout, account management, and OAuth/OIDC.
2. Add separate rows for capabilities, filtering, event context, read markers, device management, OpenID, secrets, guest access, ignore users, threading, mentions, and server notices.
3. Add separate server-server rows for API standards, TLS, discovery, transactions, PDU receipt checks, EDUs, signing/hashes, ACLs, and policy servers.
4. Stop using `✅` as the only status marker for broad categories whose submodules are still unaudited.

## Complement Evidence Summary

Complement Evidence Summary の一覧と証跡は [`docs/matrix/speccheck-matrix-v2-complement.md`](./speccheck-matrix-v2-complement.md) に移動しました。

OpenAPI operation（endpoint）一覧の導線は [`docs/matrix/speccheck-matrix-v2-endpoint.md`](./speccheck-matrix-v2-endpoint.md) にあります。

## Suggested Next Step

Once this v2 file is accepted, the next cleanup should be:

1. Convert `docs/matrix/speccheck-matrix.md` into a short overview only.
2. Use this file as the detailed tracking sheet.
3. Add one more column per row for `surface`, `behavior`, and `evidence` status values.
4. Use `complement-gap-analysis.md` as the live evidence feed — update it after each test run batch.
