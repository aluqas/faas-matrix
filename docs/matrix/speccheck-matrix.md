# Matrix Spec Checklist

This document is the living checklist that used to live in `README.md`.
It tracks the implementation surface against Matrix v1.17 and related MSCs.

## Spec Compliance

**[Matrix Specification v1.17](https://spec.matrix.org/v1.17/) Compliance**

| Spec Section | Implementation | Spec Reference |
|--------------|----------------|----------------|
| [Client-Server API](https://spec.matrix.org/v1.17/client-server-api/) | [`src/api/`](../src/api/) | Auth, sync, rooms, messaging, profiles |
| [Server-Server API](https://spec.matrix.org/v1.17/server-server-api/) | [`src/api/federation.ts`](../src/api/federation.ts) | Federation, PDUs, EDUs, key exchange |
| [Room Versions](https://spec.matrix.org/v1.17/rooms/) | [`src/services/state-resolution.ts`](../src/services/state-resolution.ts), [`src/services/state-resolution-v1.ts`](../src/services/state-resolution-v1.ts), [`src/services/event-auth.ts`](../src/services/event-auth.ts) | v1-v12, event auth, state resolution |
| [End-to-End Encryption](https://spec.matrix.org/v1.17/client-server-api/#end-to-end-encryption) | [`src/api/keys.ts`](../src/api/keys.ts), [`src/api/key-backups.ts`](../src/api/key-backups.ts) | Device keys, OTKs, cross-signing, key backup |
| [OAuth 2.0 API](https://spec.matrix.org/v1.17/client-server-api/#oauth-20-api) | [`src/api/oauth.ts`](../src/api/oauth.ts), [`src/api/oidc-auth.ts`](../src/api/oidc-auth.ts) | MSC3861, MSC2965, MSC2967, MSC4191 |
| [Discovery](https://spec.matrix.org/v1.17/client-server-api/#server-discovery) | [`src/index.ts`](../src/index.ts) | `.well-known/matrix/client`, `/versions` |
| [Content Repository](https://spec.matrix.org/v1.17/client-server-api/#content-repository) | [`src/api/media.ts`](../src/api/media.ts) | Upload, download, thumbnails, MSC3916 |
| [Push Notifications](https://spec.matrix.org/v1.17/client-server-api/#push-notifications) | [`src/api/push.ts`](../src/api/push.ts), [`src/workflows/`](../src/workflows/) | Push rules, pushers |
| [Presence](https://spec.matrix.org/v1.17/client-server-api/#presence) | [`src/api/presence.ts`](../src/api/presence.ts) | Online/offline status |
| [Typing Notifications](https://spec.matrix.org/v1.17/client-server-api/#typing-notifications) | [`src/api/typing.ts`](../src/api/typing.ts) | Typing indicators |
| [Receipts](https://spec.matrix.org/v1.17/client-server-api/#receipts) | [`src/api/receipts.ts`](../src/api/receipts.ts) | Read receipts |
| [Spaces](https://spec.matrix.org/v1.17/client-server-api/#spaces) | [`src/api/spaces.ts`](../src/api/spaces.ts) | Space hierarchy |
| [VoIP](https://spec.matrix.org/v1.17/client-server-api/#voice-over-ip) | [`src/api/voip.ts`](../src/api/voip.ts), [`src/api/calls.ts`](../src/api/calls.ts) | TURN servers, MatrixRTC |
| [Account Data](https://spec.matrix.org/v1.17/client-server-api/#client-config) | [`src/api/account-data.ts`](../src/api/account-data.ts) | User/room account data |
| [3PID Management](https://spec.matrix.org/v1.17/client-server-api/#adding-account-administrative-contact-information) | [`src/api/account.ts`](../src/api/account.ts) | Email verification, 3PID binding |

## Unstable Features

| Feature | Implementation | MSC |
|---------|----------------|-----|
| Sliding Sync | [`src/api/sliding-sync.ts`](../src/api/sliding-sync.ts) | [MSC3575](https://github.com/matrix-org/matrix-spec-proposals/pull/3575), [MSC4186](https://github.com/matrix-org/matrix-spec-proposals/pull/4186) |
| Authenticated Media | [`src/api/media.ts`](../src/api/media.ts) | [MSC3916](https://github.com/matrix-org/matrix-spec-proposals/pull/3916) |
| Cross-signing Reset | [`src/api/keys.ts`](../src/api/keys.ts), [`src/api/oauth.ts`](../src/api/oauth.ts) | [MSC4312](https://github.com/matrix-org/matrix-spec-proposals/pull/4312) |
| Account Management | [`src/api/oidc-auth.ts`](../src/api/oidc-auth.ts) | [MSC4191](https://github.com/matrix-org/matrix-spec-proposals/pull/4191) |

## API Coverage

### Client-Server API

| Category | Endpoints | Status |
|----------|-----------|--------|
| Authentication | `/login`, `/register`, `/logout`, `/refresh`, `/auth_metadata`, `/login/get_token` | ✅ |
| Sync | `/sync`, Sliding Sync (MSC3575/MSC4186), filter persistence & application | ✅ |
| Rooms | Create, join, leave, invite, kick, ban, knock, upgrade, summary | ✅ |
| Messaging | Send, redact, edit, reply | ✅ |
| State | Room state, power levels | ✅ |
| E2EE | Device keys, OTKs, cross-signing, key backup | ✅ |
| To-Device | Encrypted message relay | ✅ |
| Push | Push rules, pushers (APNs/FCM) | ✅ |
| Media | Upload, download, thumbnails (MSC3916 auth) | ✅ |
| Profile | Display name, avatar, custom profile keys | ✅ |
| Presence | Online/offline status with KV caching | ✅ |
| Typing | Typing indicators | ✅ |
| Receipts | Read receipts | ✅ |
| Account Data | User settings, room tags | ✅ |
| Directory | Room directory, aliases | ✅ |
| Discovery | `.well-known/matrix/*` (client, server, support) | ✅ |
| Reporting | Report events, rooms, users | ✅ |
| Admin | User session info (`/admin/whois`), full admin API | ✅ |
| 3PID | Email verification, 3PID management | ✅ |
| Timestamps | `timestamp_to_event` for event lookup | ✅ |

### Server-Server API

| Category | Endpoint | Purpose | Status |
|----------|----------|---------|--------|
| Discovery | `GET /_matrix/federation/v1/version` | Server version info | ✅ |
| Keys | `GET /_matrix/key/v2/server` | Server signing keys | ✅ |
|  | `GET /_matrix/key/v2/server/{keyId}` | Specific signing key | ✅ |
|  | `POST /_matrix/key/v2/query` | Batch key query | ✅ |
|  | `GET /_matrix/key/v2/query/{serverName}` | Notary key query | ✅ |
|  | `GET /_matrix/key/v2/query/{serverName}/{keyId}` | Specific notary key | ✅ |
| E2EE | `POST /_matrix/federation/v1/user/keys/query` | Query device keys | ✅ |
|  | `POST /_matrix/federation/v1/user/keys/claim` | Claim one-time keys | ✅ |
|  | `GET /_matrix/federation/v1/user/devices/{userId}` | Get user devices | ✅ |
| Events | `PUT /_matrix/federation/v1/send/{txnId}` | Receive PDUs/EDUs | ✅ |
|  | `GET /_matrix/federation/v1/event/{eventId}` | Fetch single event | ✅ |
|  | `GET /_matrix/federation/v1/state/{roomId}` | Get room state | ✅ |
|  | `GET /_matrix/federation/v1/state_ids/{roomId}` | Get state event IDs | ✅ |
|  | `GET /_matrix/federation/v1/event_auth/{roomId}/{eventId}` | Get auth chain | ✅ |
|  | `GET /_matrix/federation/v1/backfill/{roomId}` | Fetch historical events | ✅ |
|  | `POST /_matrix/federation/v1/get_missing_events/{roomId}` | Fill event gaps | ✅ |
|  | `GET /_matrix/federation/v1/timestamp_to_event/{roomId}` | Find event by timestamp | ✅ |
| Joining | `GET /_matrix/federation/v1/make_join/{roomId}/{userId}` | Prepare join | ✅ |
|  | `PUT /_matrix/federation/v1/send_join/{roomId}/{eventId}` | Complete join (v1) | ✅ |
|  | `PUT /_matrix/federation/v2/send_join/{roomId}/{eventId}` | Complete join (v2) | ✅ |
| Leaving | `GET /_matrix/federation/v1/make_leave/{roomId}/{userId}` | Prepare leave | ✅ |
|  | `PUT /_matrix/federation/v1/send_leave/{roomId}/{eventId}` | Complete leave (v1) | ✅ |
|  | `PUT /_matrix/federation/v2/send_leave/{roomId}/{eventId}` | Complete leave (v2) | ✅ |
| Knocking | `GET /_matrix/federation/v1/make_knock/{roomId}/{userId}` | Prepare knock | ✅ |
|  | `PUT /_matrix/federation/v1/send_knock/{roomId}/{eventId}` | Complete knock | ✅ |
| Inviting | `PUT /_matrix/federation/v1/invite/{roomId}/{eventId}` | Receive invite (v1) | ✅ |
|  | `PUT /_matrix/federation/v2/invite/{roomId}/{eventId}` | Receive invite (v2) | ✅ |
| Media | `GET /_matrix/federation/v1/media/download/{mediaId}` | Download media | ✅ |
|  | `GET /_matrix/federation/v1/media/thumbnail/{mediaId}` | Get thumbnail | ✅ |
| Directory | `GET /_matrix/federation/v1/query/directory` | Resolve room alias | ✅ |
|  | `GET /_matrix/federation/v1/query/profile` | Query user profile | ✅ |
|  | `GET /_matrix/federation/v1/publicRooms` | List public rooms | ✅ |
|  | `POST /_matrix/federation/v1/publicRooms` | Search public rooms | ✅ |
| Spaces | `GET /_matrix/federation/v1/hierarchy/{roomId}` | Get space hierarchy | ✅ |
| OpenID | `GET /_matrix/federation/v1/openid/userinfo` | Validate OpenID token | ✅ |

### Matrix v1.17 Compliance Additions

| Category | Endpoint | Purpose |
|----------|----------|---------|
| Room Summary | `GET /_matrix/client/v1/room_summary/{roomIdOrAlias}` | Preview room without joining |
| Auth Metadata | `GET /_matrix/client/v1/auth_metadata` | Authentication method discovery |
| Login Token | `POST /_matrix/client/v1/login/get_token` | Generate short-lived login token (QR code login) |
| Custom Profile | `GET /_matrix/client/v3/profile/{userId}/{keyName}` | Get custom profile attribute |
|  | `PUT /_matrix/client/v3/profile/{userId}/{keyName}` | Set custom profile attribute |
|  | `DELETE /_matrix/client/v3/profile/{userId}/{keyName}` | Delete custom profile attribute |
| Reporting | `POST /_matrix/client/v3/rooms/{roomId}/report` | Report a room |
|  | `POST /_matrix/client/v3/users/{userId}/report` | Report a user |
| Admin | `GET /_matrix/client/v3/admin/whois/{userId}` | Get user session/device info |
| Timestamps | `GET /_matrix/client/v3/rooms/{roomId}/timestamp_to_event` | Find event by timestamp |
| 3PID | `POST /_matrix/client/v3/account/3pid/email/requestToken` | Request email verification |
|  | `POST /_matrix/client/v3/account/3pid/submit_token` | Submit verification code |
|  | `POST /_matrix/client/v3/account/3pid/add` | Add verified 3PID to account |
| Federation | `PUT /_matrix/federation/v1/exchange_third_party_invite/{roomId}` | Third-party invite exchange |
| Sync Filters | Filter loading and application | Filters are now applied during sync |
