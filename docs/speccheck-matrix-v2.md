# Matrix Spec Check v2

This document is a more granular replacement candidate for `docs/speccheck-matrix.md`.
The goal is to track Matrix compatibility against the specification at the level of spec sections and modules, rather than broad feature buckets.

This is intentionally stricter than the current v1 checklist:

- `surface` means there is an obvious route, module, or service in the repo.
- `behavior` means the implementation has been checked against the spec semantics.
- `evidence` means tests or interop runs exist and are documented.

## Status Legend

Use the following markers per row:

- `surface`
  - `present`
  - `partial`
  - `none`
- `behavior`
  - `audited`
  - `partial`
  - `not-audited`
- `evidence`
  - `tests`
  - `interop`
  - `complement`
  - `none`

The intent is to stop treating `route exists` as equivalent to `spec implemented`.

## Client-Server Core

| Area | Current repo surface | What v2 should track |
|------|----------------------|----------------------|
| API standards | `src/index.ts`, middleware, error utilities | Standard error response, content types, JSON shape, transaction identifiers |
| Web browser clients | no explicit tracking | Browser-specific access token handling and discovery expectations |
| Server discovery | `src/index.ts`, `src/api/versions.ts` | `/.well-known`, versions, auth metadata, capability exposure |
| Client authentication | `src/api/login.ts`, `src/api/oauth.ts`, `src/api/oidc-auth.ts`, `src/api/qr-login.ts`, `src/middleware/auth.ts` | Registration, login, access-token semantics, refresh, soft logout, account management, legacy API, OAuth 2.0 API |
| Capabilities negotiation | route surface likely present via versions/capabilities logic | Individual capabilities, advertised values, and alignment with actual behavior |
| Filtering | `src/api/sync.ts`, `src/api/sliding-sync.ts`, persistence in services/DB | Filter create/load/apply semantics, lazy-loaded members |
| Events | `src/api/rooms.ts`, `src/api/relations.ts`, `src/api/sync.ts` | Event format, size limits, event context, relations, sync semantics, timeline semantics |
| Rooms | `src/api/rooms.ts`, `src/api/aliases.ts`, `src/api/spaces.ts` | Creation, aliases, permissions, membership, public room directory, summaries |
| User data | `src/api/profile.ts`, `src/api/account-data.ts`, `src/api/tags.ts`, `src/api/search.ts` | User directory, profiles, account data rules |
| Support information | no explicit tracking | Support endpoint surface and published support metadata |

## Client-Server Modules

| Module | Current repo surface | Gaps to track explicitly in v2 |
|--------|----------------------|--------------------------------|
| Content repository | `src/api/media.ts` | `mxc://` semantics, thumbnails, auth media, federation media interplay |
| Direct messaging | no dedicated `dm` module; room/account-data surface exists | `m.direct` behavior, client/server behavior |
| Ignoring users | no obvious dedicated route/module | `m.ignored_user_list`, sync filtering rules, invite suppression |
| Instant messaging | `src/api/rooms.ts` | msgtypes, message event details, fallback behavior |
| Presence | `src/api/presence.ts` | presence EDUs, last active, capability alignment |
| Push notifications | `src/api/push.ts`, `src/services/push-rule-evaluator.ts` | push rules correctness, mention rules, pusher semantics |
| Receipts | `src/api/receipts.ts` | threaded receipts, private receipts, batching semantics |
| Room history visibility | no explicit module; likely in room logic | visibility semantics per membership and guest access |
| Room upgrades | `src/api/rooms.ts` | tombstones, predecessor/successor semantics |
| Third-party invites | `src/api/federation.ts`, room invite logic | client and federation sides, invite state correctness |
| Typing notifications | `src/api/typing.ts` | security considerations, timeout behavior |
| User and room mentions | no dedicated route/module; push/events surface exists | `m.mentions`, encrypted-event handling, push integration |
| Voice over IP | `src/api/voip.ts`, `src/api/calls.ts`, `src/api/rtc.ts` | call event semantics, party identifiers, interoperability scope |
| Client config | `src/api/account-data.ts` | full account-data semantics including reserved event types |
| Application service adjunct endpoints | `src/api/appservice.ts` | appservice-related client-server auxiliary endpoints and compatibility scope |
| Device management | `src/api/devices.ts`, login/auth/device binding logic | device lifecycle, delete/update semantics, security considerations |
| End-to-end encryption | `src/api/keys.ts`, `src/api/key-backups.ts`, `src/api/to-device.ts`, `src/durable-objects/UserKeysDurableObject.ts` | device keys, cross-signing, secret storage, verification, backup, device list updates |
| Event annotations and reactions | `src/api/relations.ts` | aggregation semantics, ignored-user behavior |
| Event context | no obvious dedicated route/module | event context endpoint and semantics |
| Event replacements | `src/api/relations.ts`, event send logic | edits, `m.new_content`, encrypted edit behavior, mentions interaction |
| Read and unread markers | partial via receipts/account-data/sync | fully-read markers, unread markers, client/server behavior |
| Guest access | no obvious dedicated module | guest registration, guest tokens, guest room access rules |
| Moderation policy lists | no obvious dedicated module | policy list events and client behavior |
| Policy servers | no obvious dedicated module | currently missing from both docs; impacts federation and event validation |
| OpenID | likely federation OpenID only; no clear client-server row | client OpenID token issuance and usage |
| Notifications | partial via sync/push surface | notifications endpoint semantics and unread/notification count alignment |
| Old sync and legacy endpoints | no explicit tracking | legacy sync and room initial sync semantics, if exposed |
| Peeking events | no explicit tracking | peek/event stream semantics and compatibility stance |
| Recently used emoji | no obvious dedicated module | account-data behavior |
| Reference relations | `src/api/relations.ts` | server-side aggregation correctness |
| Reporting content | `src/api/report.ts` | report semantics, server behavior |
| Rich replies | `src/api/relations.ts`, room send logic | reply fallback/body formatting semantics |
| Room previews | room summary surface present | preview semantics and security considerations |
| Room tagging | `src/api/tags.ts` | account-data behavior and sync implications |
| SSO client login/authentication | `src/api/oidc-auth.ts`, `src/api/oauth.ts` | SSO login semantics distinct from generic OAuth |
| Secrets | no dedicated route/module; implied by E2EE ambition | SSSS and secret-sharing need explicit tracking |
| Send-to-device messaging | `src/api/to-device.ts` | batching, delivery semantics, device targeting |
| Server ACLs | no explicit dedicated route/module | ACL state handling and federation impact |
| Server administration | `src/api/admin.ts` | admin API scope should be tracked separately from Matrix core |
| Server notices | `src/api/server-notices.ts` | room semantics and client impact |
| Server side search | `src/api/search.ts` | search categories, pagination, ranking/scope limits |
| Spaces | `src/api/spaces.ts` | hierarchy semantics and federation interplay |
| Sticker messages | no obvious dedicated module | sticker event semantics |
| Third-party networks | no obvious dedicated module | third-party protocol/network lookups |
| Threading | `src/api/relations.ts`, `src/api/receipts.ts`, sync logic | thread listing, aggregation, receipts, notification counts |
| Invite permission | no explicit dedicated module | room/account-data behavior and client semantics |

## Server-Server Core

| Area | Current repo surface | What v2 should track |
|------|----------------------|----------------------|
| API standards | `src/api/federation.ts` | JSON request/response shape, UTF-8, unsupported endpoint behavior |
| TLS | no explicit tracking in current docs | certificate rules, SNI expectations, test-mode allowances |
| Unsupported endpoints | no explicit tracking | `404/405 M_UNRECOGNIZED` behavior |
| Server discovery | `src/services/server-discovery.ts`, federation routes | `.well-known`, SRV, delegated names, cache policy |
| Authentication | `src/middleware/federation-auth.ts`, `src/services/federation-keys.ts`, crypto utils | request auth, response auth, client TLS certificate assumptions |
| Transactions | `src/api/federation.ts`, `src/services/transactions.ts` | transaction size limits, idempotency, retry semantics |
| PDUs | `src/api/federation.ts`, `src/services/event-auth.ts`, `src/services/state-resolution*.ts` | receipt checks, reject vs soft-fail, room-version-sensitive validation |
| EDUs | `src/api/federation.ts`, sync/presence/push surfaces | EDU-specific semantics and delivery guarantees |
| Room state resolution | `src/services/state-resolution.ts`, `src/services/state-resolution-v1.ts` | room-version-specific state resolution, not generic one-size-fits-all |
| Backfill / missing events | `src/api/federation.ts` | bounds, validation, ordering, persistence safety |
| Retrieving events | `src/api/federation.ts` | single event, state, state IDs, event auth |
| Joining rooms | `src/api/federation.ts`, `src/workflows/RoomJoinWorkflow.ts` | complete handshake semantics, template checks, state/auth_chain correctness |
| Knocking | `src/api/federation.ts` | full handshake, retraction/leaving semantics |
| Inviting | `src/api/federation.ts` | v1/v2 invites, `invite_room_state`, room-version formatting |
| Leaving rooms | `src/api/federation.ts` | invite rejection and knock retraction semantics |
| Third-party invites | `src/api/federation.ts` | identity-service-linked flow correctness |
| Published room directory | `src/api/federation.ts`, alias/rooms APIs | federation search/list semantics |
| Spaces | `src/api/federation.ts`, `src/api/spaces.ts` | federation hierarchy behavior |
| Typing / Presence / Receipts | `src/api/federation.ts`, corresponding client APIs | EDU federation semantics, batching, expiry |
| Querying for information | `src/api/federation.ts` | directory/profile/user/device queries |
| OpenID | `src/api/federation.ts` | federation OpenID validation |
| Device management | `src/api/federation.ts`, `src/api/devices.ts` | user devices over federation |
| End-to-end encryption | `src/api/federation.ts`, `src/api/keys.ts` | device-key query, claim, cross-server key handling |
| Send-to-device messaging | partial via client API and federation surface | remote to-device semantics |
| Content repository | `src/api/federation.ts`, `src/api/media.ts` | media download/thumbnail federation semantics |
| Server ACLs | no explicit tracking | ACL enforcement against federation |
| Policy servers | no explicit tracking | policy-server enablement and signature validation |
| Signing events | crypto utils and federation code | content hash, reference hash, signature generation and verification |
| Security considerations | spread across middleware/services | explicit threat-model and failure-mode checklist |

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

The current `docs/speccheck-matrix.md` should be considered incomplete until at least the following are broken out:

1. Split `Authentication` into registration, login, tokens, refresh, soft logout, account management, and OAuth/OIDC.
2. Add separate rows for capabilities, filtering, event context, read markers, device management, OpenID, secrets, guest access, ignore users, threading, mentions, and server notices.
3. Add separate server-server rows for API standards, TLS, discovery, transactions, PDU receipt checks, EDUs, signing/hashes, ACLs, and policy servers.
4. Stop using `✅` as the only status marker for broad categories whose submodules are still unaudited.

## Suggested Next Step

Once this v2 file is accepted, the next cleanup should be:

1. Convert `docs/speccheck-matrix.md` into a short overview only.
2. Use this file as the detailed tracking sheet.
3. Add one more column per row for `surface`, `behavior`, and `evidence` status values.
