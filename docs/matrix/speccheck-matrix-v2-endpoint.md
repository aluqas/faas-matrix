# speccheck-matrix-v2 Endpoint Map

This document is generated from `docs/spec-coverage/openapi-row-map.json` (operation mapping) plus `docs/spec-coverage/openapi-units.json` (operation inventory).

Row groups are keyed by `row_id` from `docs/matrix/speccheck-matrix-v2.md`.
It is a “導線” view: this file does not participate in coverage target extraction.

## API standards (cs-core-api-standards)

Mapped operations: 0

_No operations mapped yet._

## Web browser clients (cs-core-web-browser-clients)

Mapped operations: 0

_No operations mapped yet._

## Server discovery (cs-core-server-discovery)

Mapped operations: 2

| operationId    | method | path           | operationKey         |
| -------------- | ------ | -------------- | -------------------- |
| `getWellknown` | `GET`  | /matrix/client | `GET /matrix/client` |
| `getVersions`  | `GET`  | /versions      | `GET /versions`      |

## Client authentication (cs-core-client-authentication)

Mapped operations: 25

| operationId                         | method | path                                          | operationKey                                        |
| ----------------------------------- | ------ | --------------------------------------------- | --------------------------------------------------- |
| `getAccount3PIDs`                   | `GET`  | /account/3pid                                 | `GET /account/3pid`                                 |
| `getTokenOwner`                     | `GET`  | /account/whoami                               | `GET /account/whoami`                               |
| `getAuthMetadata`                   | `GET`  | /auth_metadata                                | `GET /auth_metadata`                                |
| `getLoginFlows`                     | `GET`  | /login                                        | `GET /login`                                        |
| `checkUsernameAvailability`         | `GET`  | /register/available                           | `GET /register/available`                           |
| `registrationTokenValidity`         | `GET`  | /register/m.login.registration_token/validity | `GET /register/m.login.registration_token/validity` |
| `post3PIDs`                         | `POST` | /account/3pid                                 | `POST /account/3pid`                                |
| `add3PID`                           | `POST` | /account/3pid/add                             | `POST /account/3pid/add`                            |
| `bind3PID`                          | `POST` | /account/3pid/bind                            | `POST /account/3pid/bind`                           |
| `delete3pidFromAccount`             | `POST` | /account/3pid/delete                          | `POST /account/3pid/delete`                         |
| `requestTokenTo3PIDEmail`           | `POST` | /account/3pid/email/requestToken              | `POST /account/3pid/email/requestToken`             |
| `requestTokenTo3PIDMSISDN`          | `POST` | /account/3pid/msisdn/requestToken             | `POST /account/3pid/msisdn/requestToken`            |
| `unbind3pidFromAccount`             | `POST` | /account/3pid/unbind                          | `POST /account/3pid/unbind`                         |
| `deactivateAccount`                 | `POST` | /account/deactivate                           | `POST /account/deactivate`                          |
| `changePassword`                    | `POST` | /account/password                             | `POST /account/password`                            |
| `requestTokenToResetPasswordEmail`  | `POST` | /account/password/email/requestToken          | `POST /account/password/email/requestToken`         |
| `requestTokenToResetPasswordMSISDN` | `POST` | /account/password/msisdn/requestToken         | `POST /account/password/msisdn/requestToken`        |
| `login`                             | `POST` | /login                                        | `POST /login`                                       |
| `generateLoginToken`                | `POST` | /login/get_token                              | `POST /login/get_token`                             |
| `logout`                            | `POST` | /logout                                       | `POST /logout`                                      |
| `logout_all`                        | `POST` | /logout/all                                   | `POST /logout/all`                                  |
| `refresh`                           | `POST` | /refresh                                      | `POST /refresh`                                     |
| `register`                          | `POST` | /register                                     | `POST /register`                                    |
| `requestTokenToRegisterEmail`       | `POST` | /register/email/requestToken                  | `POST /register/email/requestToken`                 |
| `requestTokenToRegisterMSISDN`      | `POST` | /register/msisdn/requestToken                 | `POST /register/msisdn/requestToken`                |

## Capabilities negotiation (cs-core-capabilities-negotiation)

Mapped operations: 1

| operationId       | method | path          | operationKey        |
| ----------------- | ------ | ------------- | ------------------- |
| `getCapabilities` | `GET`  | /capabilities | `GET /capabilities` |

## Filtering (cs-core-filtering)

Mapped operations: 2

| operationId    | method | path                             | operationKey                           |
| -------------- | ------ | -------------------------------- | -------------------------------------- |
| `getFilter`    | `GET`  | /user/{userId}/filter/{filterId} | `GET /user/{userId}/filter/{filterId}` |
| `defineFilter` | `POST` | /user/{userId}/filter            | `POST /user/{userId}/filter`           |

## Events (cs-core-events)

Mapped operations: 5

| operationId           | method | path                                     | operationKey                                   |
| --------------------- | ------ | ---------------------------------------- | ---------------------------------------------- |
| `getRoomEvents`       | `GET`  | /rooms/{roomId}/messages                 | `GET /rooms/{roomId}/messages`                 |
| `getEventByTimestamp` | `GET`  | /rooms/{roomId}/timestamp_to_event       | `GET /rooms/{roomId}/timestamp_to_event`       |
| `sync`                | `GET`  | /sync                                    | `GET /sync`                                    |
| `redactEvent`         | `PUT`  | /rooms/{roomId}/redact/{eventId}/{txnId} | `PUT /rooms/{roomId}/redact/{eventId}/{txnId}` |
| `sendMessage`         | `PUT`  | /rooms/{roomId}/send/{eventType}/{txnId} | `PUT /rooms/{roomId}/send/{eventType}/{txnId}` |

## Rooms (cs-core-rooms)

Mapped operations: 25

| operationId                    | method   | path                                         | operationKey                                       |
| ------------------------------ | -------- | -------------------------------------------- | -------------------------------------------------- |
| `deleteRoomAlias`              | `DELETE` | /directory/room/{roomAlias}                  | `DELETE /directory/room/{roomAlias}`               |
| `getRoomVisibilityOnDirectory` | `GET`    | /directory/list/room/{roomId}                | `GET /directory/list/room/{roomId}`                |
| `getRoomIdByAlias`             | `GET`    | /directory/room/{roomAlias}                  | `GET /directory/room/{roomAlias}`                  |
| `getJoinedRooms`               | `GET`    | /joined_rooms                                | `GET /joined_rooms`                                |
| `getPublicRooms`               | `GET`    | /publicRooms                                 | `GET /publicRooms`                                 |
| `getLocalAliases`              | `GET`    | /rooms/{roomId}/aliases                      | `GET /rooms/{roomId}/aliases`                      |
| `getOneRoomEvent`              | `GET`    | /rooms/{roomId}/event/{eventId}              | `GET /rooms/{roomId}/event/{eventId}`              |
| `getJoinedMembersByRoom`       | `GET`    | /rooms/{roomId}/joined_members               | `GET /rooms/{roomId}/joined_members`               |
| `getMembersByRoom`             | `GET`    | /rooms/{roomId}/members                      | `GET /rooms/{roomId}/members`                      |
| `getRoomState`                 | `GET`    | /rooms/{roomId}/state                        | `GET /rooms/{roomId}/state`                        |
| `getRoomStateWithKey`          | `GET`    | /rooms/{roomId}/state/{eventType}/{stateKey} | `GET /rooms/{roomId}/state/{eventType}/{stateKey}` |
| `createRoom`                   | `POST`   | /createRoom                                  | `POST /createRoom`                                 |
| `joinRoom`                     | `POST`   | /join/{roomIdOrAlias}                        | `POST /join/{roomIdOrAlias}`                       |
| `knockRoom`                    | `POST`   | /knock/{roomIdOrAlias}                       | `POST /knock/{roomIdOrAlias}`                      |
| `queryPublicRooms`             | `POST`   | /publicRooms                                 | `POST /publicRooms`                                |
| `ban`                          | `POST`   | /rooms/{roomId}/ban                          | `POST /rooms/{roomId}/ban`                         |
| `forgetRoom`                   | `POST`   | /rooms/{roomId}/forget                       | `POST /rooms/{roomId}/forget`                      |
| `inviteUser`                   | `POST`   | /rooms/{roomId}/invite                       | `POST /rooms/{roomId}/invite `                     |
| `joinRoomById`                 | `POST`   | /rooms/{roomId}/join                         | `POST /rooms/{roomId}/join`                        |
| `kick`                         | `POST`   | /rooms/{roomId}/kick                         | `POST /rooms/{roomId}/kick`                        |
| `leaveRoom`                    | `POST`   | /rooms/{roomId}/leave                        | `POST /rooms/{roomId}/leave`                       |
| `unban`                        | `POST`   | /rooms/{roomId}/unban                        | `POST /rooms/{roomId}/unban`                       |
| `setRoomVisibilityOnDirectory` | `PUT`    | /directory/list/room/{roomId}                | `PUT /directory/list/room/{roomId}`                |
| `setRoomAlias`                 | `PUT`    | /directory/room/{roomAlias}                  | `PUT /directory/room/{roomAlias}`                  |
| `setRoomStateWithKey`          | `PUT`    | /rooms/{roomId}/state/{eventType}/{stateKey} | `PUT /rooms/{roomId}/state/{eventType}/{stateKey}` |

## User data (cs-core-user-data)

Mapped operations: 5

| operationId           | method   | path                        | operationKey                         |
| --------------------- | -------- | --------------------------- | ------------------------------------ |
| `deleteProfileField`  | `DELETE` | /profile/{userId}/{keyName} | `DELETE /profile/{userId}/{keyName}` |
| `getUserProfile`      | `GET`    | /profile/{userId}           | `GET /profile/{userId}`              |
| `getProfileField`     | `GET`    | /profile/{userId}/{keyName} | `GET /profile/{userId}/{keyName}`    |
| `searchUserDirectory` | `POST`   | /user_directory/search      | `POST /user_directory/search`        |
| `setProfileField`     | `PUT`    | /profile/{userId}/{keyName} | `PUT /profile/{userId}/{keyName}`    |

## Support information (cs-core-support-information)

Mapped operations: 1

| operationId           | method | path            | operationKey          |
| --------------------- | ------ | --------------- | --------------------- |
| `getWellknownSupport` | `GET`  | /matrix/support | `GET /matrix/support` |

## Content repository (cs-module-content-repository)

Mapped operations: 13

| operationId                    | method | path                                                 | operationKey                                               |
| ------------------------------ | ------ | ---------------------------------------------------- | ---------------------------------------------------------- |
| `getConfigAuthed`              | `GET`  | /media/config                                        | `GET /media/config`                                        |
| `getContentAuthed`             | `GET`  | /media/download/{serverName}/{mediaId}               | `GET /media/download/{serverName}/{mediaId}`               |
| `getContentOverrideNameAuthed` | `GET`  | /media/download/{serverName}/{mediaId}/{fileName}    | `GET /media/download/{serverName}/{mediaId}/{fileName}`    |
| `getUrlPreviewAuthed`          | `GET`  | /media/preview_url                                   | `GET /media/preview_url`                                   |
| `getContentThumbnailAuthed`    | `GET`  | /media/thumbnail/{serverName}/{mediaId}              | `GET /media/thumbnail/{serverName}/{mediaId}`              |
| `getConfig`                    | `GET`  | /media/v3/config                                     | `GET /media/v3/config`                                     |
| `getContent`                   | `GET`  | /media/v3/download/{serverName}/{mediaId}            | `GET /media/v3/download/{serverName}/{mediaId}`            |
| `getContentOverrideName`       | `GET`  | /media/v3/download/{serverName}/{mediaId}/{fileName} | `GET /media/v3/download/{serverName}/{mediaId}/{fileName}` |
| `getUrlPreview`                | `GET`  | /media/v3/preview_url                                | `GET /media/v3/preview_url`                                |
| `getContentThumbnail`          | `GET`  | /media/v3/thumbnail/{serverName}/{mediaId}           | `GET /media/v3/thumbnail/{serverName}/{mediaId}`           |
| `createContent`                | `POST` | /media/v1/create                                     | `POST /media/v1/create`                                    |
| `uploadContent`                | `POST` | /media/v3/upload                                     | `POST /media/v3/upload`                                    |
| `uploadContentToMXC`           | `PUT`  | /media/v3/upload/{serverName}/{mediaId}              | `PUT /media/v3/upload/{serverName}/{mediaId}`              |

## Direct messaging (cs-module-direct-messaging)

Mapped operations: 0

_No operations mapped yet._

## Ignoring users (cs-module-ignoring-users)

Mapped operations: 0

_No operations mapped yet._

## Instant messaging (cs-module-instant-messaging)

Mapped operations: 0

_No operations mapped yet._

## Presence (cs-module-presence)

Mapped operations: 2

| operationId   | method | path                      | operationKey                    |
| ------------- | ------ | ------------------------- | ------------------------------- |
| `getPresence` | `GET`  | /presence/{userId}/status | `GET /presence/{userId}/status` |
| `setPresence` | `PUT`  | /presence/{userId}/status | `PUT /presence/{userId}/status` |

## Push notifications (cs-module-push-notifications)

Mapped operations: 11

| operationId          | method   | path                                      | operationKey                                    |
| -------------------- | -------- | ----------------------------------------- | ----------------------------------------------- |
| `deletePushRule`     | `DELETE` | /pushrules/global/{kind}/{ruleId}         | `DELETE /pushrules/global/{kind}/{ruleId}`      |
| `getPushers`         | `GET`    | /pushers                                  | `GET /pushers`                                  |
| `getPushRules`       | `GET`    | /pushrules/                               | `GET /pushrules/`                               |
| `getPushRulesGlobal` | `GET`    | /pushrules/global/                        | `GET /pushrules/global/`                        |
| `getPushRule`        | `GET`    | /pushrules/global/{kind}/{ruleId}         | `GET /pushrules/global/{kind}/{ruleId}`         |
| `getPushRuleActions` | `GET`    | /pushrules/global/{kind}/{ruleId}/actions | `GET /pushrules/global/{kind}/{ruleId}/actions` |
| `isPushRuleEnabled`  | `GET`    | /pushrules/global/{kind}/{ruleId}/enabled | `GET /pushrules/global/{kind}/{ruleId}/enabled` |
| `postPusher`         | `POST`   | /pushers/set                              | `POST /pushers/set`                             |
| `setPushRule`        | `PUT`    | /pushrules/global/{kind}/{ruleId}         | `PUT /pushrules/global/{kind}/{ruleId}`         |
| `setPushRuleActions` | `PUT`    | /pushrules/global/{kind}/{ruleId}/actions | `PUT /pushrules/global/{kind}/{ruleId}/actions` |
| `setPushRuleEnabled` | `PUT`    | /pushrules/global/{kind}/{ruleId}/enabled | `PUT /pushrules/global/{kind}/{ruleId}/enabled` |

## Receipts (cs-module-receipts)

Mapped operations: 1

| operationId   | method | path                                            | operationKey                                           |
| ------------- | ------ | ----------------------------------------------- | ------------------------------------------------------ |
| `postReceipt` | `POST` | /rooms/{roomId}/receipt/{receiptType}/{eventId} | `POST /rooms/{roomId}/receipt/{receiptType}/{eventId}` |

## Room history visibility (cs-module-room-history-visibility)

Mapped operations: 0

_No operations mapped yet._

## Room upgrades (cs-module-room-upgrades)

Mapped operations: 1

| operationId   | method | path                    | operationKey                   |
| ------------- | ------ | ----------------------- | ------------------------------ |
| `upgradeRoom` | `POST` | /rooms/{roomId}/upgrade | `POST /rooms/{roomId}/upgrade` |

## Third-party invites (cs-module-third-party-invites)

Mapped operations: 1

| operationId    | method | path                   | operationKey                  |
| -------------- | ------ | ---------------------- | ----------------------------- |
| `inviteBy3PID` | `POST` | /rooms/{roomId}/invite | `POST /rooms/{roomId}/invite` |

## Typing notifications (cs-module-typing-notifications)

Mapped operations: 1

| operationId | method | path                            | operationKey                          |
| ----------- | ------ | ------------------------------- | ------------------------------------- |
| `setTyping` | `PUT`  | /rooms/{roomId}/typing/{userId} | `PUT /rooms/{roomId}/typing/{userId}` |

## User and room mentions (cs-module-user-and-room-mentions)

Mapped operations: 0

_No operations mapped yet._

## Voice over IP (cs-module-voice-over-ip)

Mapped operations: 1

| operationId     | method | path             | operationKey           |
| --------------- | ------ | ---------------- | ---------------------- |
| `getTurnServer` | `GET`  | /voip/turnServer | `GET /voip/turnServer` |

## Client config (cs-module-client-config)

Mapped operations: 4

| operationId             | method | path                                              | operationKey                                            |
| ----------------------- | ------ | ------------------------------------------------- | ------------------------------------------------------- |
| `getAccountData`        | `GET`  | /user/{userId}/account_data/{type}                | `GET /user/{userId}/account_data/{type}`                |
| `getAccountDataPerRoom` | `GET`  | /user/{userId}/rooms/{roomId}/account_data/{type} | `GET /user/{userId}/rooms/{roomId}/account_data/{type}` |
| `setAccountData`        | `PUT`  | /user/{userId}/account_data/{type}                | `PUT /user/{userId}/account_data/{type}`                |
| `setAccountDataPerRoom` | `PUT`  | /user/{userId}/rooms/{roomId}/account_data/{type} | `PUT /user/{userId}/rooms/{roomId}/account_data/{type}` |

## Application service adjunct endpoints (cs-module-application-service-adjunct-endpoints)

Mapped operations: 2

| operationId                               | method | path                                            | operationKey                                          |
| ----------------------------------------- | ------ | ----------------------------------------------- | ----------------------------------------------------- |
| `pingAppservice`                          | `POST` | /appservice/{appserviceId}/ping                 | `POST /appservice/{appserviceId}/ping`                |
| `updateAppserviceRoomDirectoryVisibility` | `PUT`  | /directory/list/appservice/{networkId}/{roomId} | `PUT /directory/list/appservice/{networkId}/{roomId}` |

## Device management (cs-module-device-management)

Mapped operations: 5

| operationId     | method   | path                | operationKey                 |
| --------------- | -------- | ------------------- | ---------------------------- |
| `deleteDevice`  | `DELETE` | /devices/{deviceId} | `DELETE /devices/{deviceId}` |
| `getDevices`    | `GET`    | /devices            | `GET /devices`               |
| `getDevice`     | `GET`    | /devices/{deviceId} | `GET /devices/{deviceId}`    |
| `deleteDevices` | `POST`   | /delete_devices     | `POST /delete_devices`       |
| `updateDevice`  | `PUT`    | /devices/{deviceId} | `PUT /devices/{deviceId}`    |

## End-to-end encryption (cs-module-end-to-end-encryption)

Mapped operations: 20

| operationId                    | method   | path                                 | operationKey                                  |
| ------------------------------ | -------- | ------------------------------------ | --------------------------------------------- |
| `deleteRoomKeys`               | `DELETE` | /room_keys/keys                      | `DELETE /room_keys/keys`                      |
| `deleteRoomKeysByRoomId`       | `DELETE` | /room_keys/keys/{roomId}             | `DELETE /room_keys/keys/{roomId}`             |
| `deleteRoomKeyBySessionId`     | `DELETE` | /room_keys/keys/{roomId}/{sessionId} | `DELETE /room_keys/keys/{roomId}/{sessionId}` |
| `deleteRoomKeysVersion`        | `DELETE` | /room_keys/version/{version}         | `DELETE /room_keys/version/{version}`         |
| `getKeysChanges`               | `GET`    | /keys/changes                        | `GET /keys/changes`                           |
| `getRoomKeys`                  | `GET`    | /room_keys/keys                      | `GET /room_keys/keys`                         |
| `getRoomKeysByRoomId`          | `GET`    | /room_keys/keys/{roomId}             | `GET /room_keys/keys/{roomId}`                |
| `getRoomKeyBySessionId`        | `GET`    | /room_keys/keys/{roomId}/{sessionId} | `GET /room_keys/keys/{roomId}/{sessionId}`    |
| `getRoomKeysVersionCurrent`    | `GET`    | /room_keys/version                   | `GET /room_keys/version`                      |
| `getRoomKeysVersion`           | `GET`    | /room_keys/version/{version}         | `GET /room_keys/version/{version}`            |
| `claimKeys`                    | `POST`   | /keys/claim                          | `POST /keys/claim`                            |
| `uploadCrossSigningKeys`       | `POST`   | /keys/device_signing/upload          | `POST /keys/device_signing/upload`            |
| `queryKeys`                    | `POST`   | /keys/query                          | `POST /keys/query`                            |
| `uploadCrossSigningSignatures` | `POST`   | /keys/signatures/upload              | `POST /keys/signatures/upload`                |
| `uploadKeys`                   | `POST`   | /keys/upload                         | `POST /keys/upload`                           |
| `postRoomKeysVersion`          | `POST`   | /room_keys/version                   | `POST /room_keys/version`                     |
| `putRoomKeys`                  | `PUT`    | /room_keys/keys                      | `PUT /room_keys/keys`                         |
| `putRoomKeysByRoomId`          | `PUT`    | /room_keys/keys/{roomId}             | `PUT /room_keys/keys/{roomId}`                |
| `putRoomKeyBySessionId`        | `PUT`    | /room_keys/keys/{roomId}/{sessionId} | `PUT /room_keys/keys/{roomId}/{sessionId}`    |
| `putRoomKeysVersion`           | `PUT`    | /room_keys/version/{version}         | `PUT /room_keys/version/{version}`            |

## Event annotations and reactions (cs-module-event-annotations-and-reactions)

Mapped operations: 3

| operationId                                | method | path                                                      | operationKey                                                    |
| ------------------------------------------ | ------ | --------------------------------------------------------- | --------------------------------------------------------------- |
| `getRelatingEvents`                        | `GET`  | /rooms/{roomId}/relations/{eventId}                       | `GET /rooms/{roomId}/relations/{eventId}`                       |
| `getRelatingEventsWithRelType`             | `GET`  | /rooms/{roomId}/relations/{eventId}/{relType}             | `GET /rooms/{roomId}/relations/{eventId}/{relType}`             |
| `getRelatingEventsWithRelTypeAndEventType` | `GET`  | /rooms/{roomId}/relations/{eventId}/{relType}/{eventType} | `GET /rooms/{roomId}/relations/{eventId}/{relType}/{eventType}` |

## Event context (cs-module-event-context)

Mapped operations: 1

| operationId       | method | path                              | operationKey                            |
| ----------------- | ------ | --------------------------------- | --------------------------------------- |
| `getEventContext` | `GET`  | /rooms/{roomId}/context/{eventId} | `GET /rooms/{roomId}/context/{eventId}` |

## Event replacements (cs-module-event-replacements)

Mapped operations: 3

| operationId                                | method | path                                                      | operationKey                                                    |
| ------------------------------------------ | ------ | --------------------------------------------------------- | --------------------------------------------------------------- |
| `getRelatingEvents`                        | `GET`  | /rooms/{roomId}/relations/{eventId}                       | `GET /rooms/{roomId}/relations/{eventId}`                       |
| `getRelatingEventsWithRelType`             | `GET`  | /rooms/{roomId}/relations/{eventId}/{relType}             | `GET /rooms/{roomId}/relations/{eventId}/{relType}`             |
| `getRelatingEventsWithRelTypeAndEventType` | `GET`  | /rooms/{roomId}/relations/{eventId}/{relType}/{eventType} | `GET /rooms/{roomId}/relations/{eventId}/{relType}/{eventType}` |

## Read and unread markers (cs-module-read-and-unread-markers)

Mapped operations: 1

| operationId     | method | path                         | operationKey                        |
| --------------- | ------ | ---------------------------- | ----------------------------------- |
| `setReadMarker` | `POST` | /rooms/{roomId}/read_markers | `POST /rooms/{roomId}/read_markers` |

## Guest access (cs-module-guest-access)

Mapped operations: 0

_No operations mapped yet._

## Moderation policy lists (cs-module-moderation-policy-lists)

Mapped operations: 0

_No operations mapped yet._

## Policy servers (cs-module-policy-servers)

Mapped operations: 1

| operationId          | method | path                  | operationKey                |
| -------------------- | ------ | --------------------- | --------------------------- |
| `getWellknownPolicy` | `GET`  | /matrix/policy_server | `GET /matrix/policy_server` |

## OpenID (cs-module-openid)

Mapped operations: 1

| operationId          | method | path                                | operationKey                               |
| -------------------- | ------ | ----------------------------------- | ------------------------------------------ |
| `requestOpenIdToken` | `POST` | /user/{userId}/openid/request_token | `POST /user/{userId}/openid/request_token` |

## Notifications (cs-module-notifications)

Mapped operations: 1

| operationId        | method | path           | operationKey         |
| ------------------ | ------ | -------------- | -------------------- |
| `getNotifications` | `GET`  | /notifications | `GET /notifications` |

## Old sync and legacy endpoints (cs-module-old-sync-and-legacy-endpoints)

Mapped operations: 4

| operationId       | method | path                        | operationKey                      |
| ----------------- | ------ | --------------------------- | --------------------------------- |
| `getEvents`       | `GET`  | /events                     | `GET /events`                     |
| `getOneEvent`     | `GET`  | /events/{eventId}           | `GET /events/{eventId}`           |
| `initialSync`     | `GET`  | /initialSync                | `GET /initialSync`                |
| `roomInitialSync` | `GET`  | /rooms/{roomId}/initialSync | `GET /rooms/{roomId}/initialSync` |

## Peeking events (cs-module-peeking-events)

Mapped operations: 1

| operationId  | method | path    | operationKey   |
| ------------ | ------ | ------- | -------------- |
| `peekEvents` | `GET`  | /events | `GET /events ` |

## Recently used emoji (cs-module-recently-used-emoji)

Mapped operations: 0

_No operations mapped yet._

## Reference relations (cs-module-reference-relations)

Mapped operations: 3

| operationId                                | method | path                                                      | operationKey                                                    |
| ------------------------------------------ | ------ | --------------------------------------------------------- | --------------------------------------------------------------- |
| `getRelatingEvents`                        | `GET`  | /rooms/{roomId}/relations/{eventId}                       | `GET /rooms/{roomId}/relations/{eventId}`                       |
| `getRelatingEventsWithRelType`             | `GET`  | /rooms/{roomId}/relations/{eventId}/{relType}             | `GET /rooms/{roomId}/relations/{eventId}/{relType}`             |
| `getRelatingEventsWithRelTypeAndEventType` | `GET`  | /rooms/{roomId}/relations/{eventId}/{relType}/{eventType} | `GET /rooms/{roomId}/relations/{eventId}/{relType}/{eventType}` |

## Reporting content (cs-module-reporting-content)

Mapped operations: 3

| operationId   | method | path                             | operationKey                            |
| ------------- | ------ | -------------------------------- | --------------------------------------- |
| `reportRoom`  | `POST` | /rooms/{roomId}/report           | `POST /rooms/{roomId}/report`           |
| `reportEvent` | `POST` | /rooms/{roomId}/report/{eventId} | `POST /rooms/{roomId}/report/{eventId}` |
| `reportUser`  | `POST` | /users/{userId}/report           | `POST /users/{userId}/report`           |

## Rich replies (cs-module-rich-replies)

Mapped operations: 3

| operationId                                | method | path                                                      | operationKey                                                    |
| ------------------------------------------ | ------ | --------------------------------------------------------- | --------------------------------------------------------------- |
| `getRelatingEvents`                        | `GET`  | /rooms/{roomId}/relations/{eventId}                       | `GET /rooms/{roomId}/relations/{eventId}`                       |
| `getRelatingEventsWithRelType`             | `GET`  | /rooms/{roomId}/relations/{eventId}/{relType}             | `GET /rooms/{roomId}/relations/{eventId}/{relType}`             |
| `getRelatingEventsWithRelTypeAndEventType` | `GET`  | /rooms/{roomId}/relations/{eventId}/{relType}/{eventType} | `GET /rooms/{roomId}/relations/{eventId}/{relType}/{eventType}` |

## Room previews (cs-module-room-previews)

Mapped operations: 1

| operationId      | method | path                          | operationKey                        |
| ---------------- | ------ | ----------------------------- | ----------------------------------- |
| `getRoomSummary` | `GET`  | /room_summary/{roomIdOrAlias} | `GET /room_summary/{roomIdOrAlias}` |

## Room tagging (cs-module-room-tagging)

Mapped operations: 3

| operationId     | method   | path                                     | operationKey                                      |
| --------------- | -------- | ---------------------------------------- | ------------------------------------------------- |
| `deleteRoomTag` | `DELETE` | /user/{userId}/rooms/{roomId}/tags/{tag} | `DELETE /user/{userId}/rooms/{roomId}/tags/{tag}` |
| `getRoomTags`   | `GET`    | /user/{userId}/rooms/{roomId}/tags       | `GET /user/{userId}/rooms/{roomId}/tags`          |
| `setRoomTag`    | `PUT`    | /user/{userId}/rooms/{roomId}/tags/{tag} | `PUT /user/{userId}/rooms/{roomId}/tags/{tag}`    |

## SSO client login/authentication (cs-module-sso-client-login-authentication)

Mapped operations: 2

| operationId     | method | path                        | operationKey                      |
| --------------- | ------ | --------------------------- | --------------------------------- |
| `redirectToSSO` | `GET`  | /login/sso/redirect         | `GET /login/sso/redirect`         |
| `redirectToIdP` | `GET`  | /login/sso/redirect/{idpId} | `GET /login/sso/redirect/{idpId}` |

## Secrets (cs-module-secrets)

Mapped operations: 0

_No operations mapped yet._

## Send-to-device messaging (cs-module-send-to-device-messaging)

Mapped operations: 1

| operationId    | method | path                              | operationKey                            |
| -------------- | ------ | --------------------------------- | --------------------------------------- |
| `sendToDevice` | `PUT`  | /sendToDevice/{eventType}/{txnId} | `PUT /sendToDevice/{eventType}/{txnId}` |

## Server ACLs (cs-module-server-access-control-lists-acls-for-rooms)

Mapped operations: 0

_No operations mapped yet._

## Server administration (cs-module-server-administration)

Mapped operations: 5

| operationId           | method | path                       | operationKey                     |
| --------------------- | ------ | -------------------------- | -------------------------------- |
| `getAdminLockUser`    | `GET`  | /v1/admin/lock/{userId}    | `GET /v1/admin/lock/{userId}`    |
| `getAdminSuspendUser` | `GET`  | /v1/admin/suspend/{userId} | `GET /v1/admin/suspend/{userId}` |
| `getWhoIs`            | `GET`  | /v3/admin/whois/{userId}   | `GET /v3/admin/whois/{userId}`   |
| `setAdminLockUser`    | `PUT`  | /v1/admin/lock/{userId}    | `PUT /v1/admin/lock/{userId}`    |
| `setAdminSuspendUser` | `PUT`  | /v1/admin/suspend/{userId} | `PUT /v1/admin/suspend/{userId}` |

## Server notices (cs-module-server-notices)

Mapped operations: 0

_No operations mapped yet._

## Server side search (cs-module-server-side-search)

Mapped operations: 1

| operationId | method | path    | operationKey   |
| ----------- | ------ | ------- | -------------- |
| `search`    | `POST` | /search | `POST /search` |

## Spaces (cs-module-spaces)

Mapped operations: 1

| operationId         | method | path                      | operationKey                    |
| ------------------- | ------ | ------------------------- | ------------------------------- |
| `getSpaceHierarchy` | `GET`  | /rooms/{roomId}/hierarchy | `GET /rooms/{roomId}/hierarchy` |

## Sticker messages (cs-module-sticker-messages)

Mapped operations: 0

_No operations mapped yet._

## Third-party networks (cs-module-third-party-networks)

Mapped operations: 6

| operationId               | method | path                            | operationKey                          |
| ------------------------- | ------ | ------------------------------- | ------------------------------------- |
| `queryLocationByAlias`    | `GET`  | /thirdparty/location            | `GET /thirdparty/location`            |
| `queryLocationByProtocol` | `GET`  | /thirdparty/location/{protocol} | `GET /thirdparty/location/{protocol}` |
| `getProtocolMetadata`     | `GET`  | /thirdparty/protocol/{protocol} | `GET /thirdparty/protocol/{protocol}` |
| `getProtocols`            | `GET`  | /thirdparty/protocols           | `GET /thirdparty/protocols`           |
| `queryUserByID`           | `GET`  | /thirdparty/user                | `GET /thirdparty/user`                |
| `queryUserByProtocol`     | `GET`  | /thirdparty/user/{protocol}     | `GET /thirdparty/user/{protocol}`     |

## Threading (cs-module-threading)

Mapped operations: 4

| operationId                                | method | path                                                      | operationKey                                                    |
| ------------------------------------------ | ------ | --------------------------------------------------------- | --------------------------------------------------------------- |
| `getRelatingEvents`                        | `GET`  | /rooms/{roomId}/relations/{eventId}                       | `GET /rooms/{roomId}/relations/{eventId}`                       |
| `getRelatingEventsWithRelType`             | `GET`  | /rooms/{roomId}/relations/{eventId}/{relType}             | `GET /rooms/{roomId}/relations/{eventId}/{relType}`             |
| `getRelatingEventsWithRelTypeAndEventType` | `GET`  | /rooms/{roomId}/relations/{eventId}/{relType}/{eventType} | `GET /rooms/{roomId}/relations/{eventId}/{relType}/{eventType}` |
| `getThreadRoots`                           | `GET`  | /rooms/{roomId}/threads                                   | `GET /rooms/{roomId}/threads`                                   |

## Invite permission (cs-module-invite-permission)

Mapped operations: 0

_No operations mapped yet._

## API standards (ss-core-api-standards)

Mapped operations: 1

| operationId  | method | path     | operationKey   |
| ------------ | ------ | -------- | -------------- |
| `getVersion` | `GET`  | /version | `GET /version` |

## TLS (ss-subsection-api-standards-tls)

Mapped operations: 0

_No operations mapped yet._

## Unsupported endpoints (ss-subsection-api-standards-unsupported-endpoints)

Mapped operations: 0

_No operations mapped yet._

## Server discovery (ss-core-server-discovery)

Mapped operations: 1

| operationId    | method | path           | operationKey         |
| -------------- | ------ | -------------- | -------------------- |
| `getWellKnown` | `GET`  | /matrix/server | `GET /matrix/server` |

## Authentication (ss-core-authentication)

Mapped operations: 3

| operationId                | method | path                | operationKey              |
| -------------------------- | ------ | ------------------- | ------------------------- |
| `perspectivesKeyQuery`     | `GET`  | /query/{serverName} | `GET /query/{serverName}` |
| `getServerKey`             | `GET`  | /server             | `GET /server`             |
| `bulkPerspectivesKeyQuery` | `POST` | /query              | `POST /query`             |

## Request Authentication (ss-subsection-authentication-request-authentication)

Mapped operations: 0

_No operations mapped yet._

## Response Authentication (ss-subsection-authentication-response-authentication)

Mapped operations: 0

_No operations mapped yet._

## Client TLS Certificates (ss-subsection-authentication-client-tls-certificates)

Mapped operations: 0

_No operations mapped yet._

## Transactions (ss-core-transactions)

Mapped operations: 1

| operationId       | method | path          | operationKey        |
| ----------------- | ------ | ------------- | ------------------- |
| `sendTransaction` | `PUT`  | /send/{txnId} | `PUT /send/{txnId}` |

## PDUs (ss-core-pdus)

Mapped operations: 0

_No operations mapped yet._

## EDUs (ss-core-edus)

Mapped operations: 0

_No operations mapped yet._

## Room state resolution (ss-core-room-state-resolution)

Mapped operations: 0

_No operations mapped yet._

## Backfill / missing events (ss-core-backfilling-and-retrieving-missing-events)

Mapped operations: 2

| operationId                | method | path                         | operationKey                        |
| -------------------------- | ------ | ---------------------------- | ----------------------------------- |
| `backfillRoom`             | `GET`  | /backfill/{roomId}           | `GET /backfill/{roomId}`            |
| `getMissingPreviousEvents` | `POST` | /get_missing_events/{roomId} | `POST /get_missing_events/{roomId}` |

## Retrieving events (ss-core-retrieving-events)

Mapped operations: 5

| operationId           | method | path                           | operationKey                         |
| --------------------- | ------ | ------------------------------ | ------------------------------------ |
| `getEventAuth`        | `GET`  | /event_auth/{roomId}/{eventId} | `GET /event_auth/{roomId}/{eventId}` |
| `getEvent`            | `GET`  | /event/{eventId}               | `GET /event/{eventId}`               |
| `getRoomStateIds`     | `GET`  | /state_ids/{roomId}            | `GET /state_ids/{roomId}`            |
| `getRoomState`        | `GET`  | /state/{roomId}                | `GET /state/{roomId}`                |
| `getEventByTimestamp` | `GET`  | /timestamp_to_event/{roomId}   | `GET /timestamp_to_event/{roomId}`   |

## Joining rooms (ss-core-joining-rooms)

Mapped operations: 2

| operationId  | method | path                          | operationKey                        |
| ------------ | ------ | ----------------------------- | ----------------------------------- |
| `makeJoin`   | `GET`  | /make_join/{roomId}/{userId}  | `GET /make_join/{roomId}/{userId}`  |
| `sendJoinV2` | `PUT`  | /send_join/{roomId}/{eventId} | `PUT /send_join/{roomId}/{eventId}` |

## Knocking (ss-core-knocking-upon-a-room)

Mapped operations: 2

| operationId | method | path                           | operationKey                         |
| ----------- | ------ | ------------------------------ | ------------------------------------ |
| `makeKnock` | `GET`  | /make_knock/{roomId}/{userId}  | `GET /make_knock/{roomId}/{userId}`  |
| `sendKnock` | `PUT`  | /send_knock/{roomId}/{eventId} | `PUT /send_knock/{roomId}/{eventId}` |

## Inviting (ss-core-inviting-to-a-room)

Mapped operations: 2

| operationId    | method | path                       | operationKey                     |
| -------------- | ------ | -------------------------- | -------------------------------- |
| `sendInviteV1` | `PUT`  | /invite/{roomId}/{eventId} | `PUT /invite/{roomId}/{eventId}` |
| `sendInviteV2` | `PUT`  | /invite/{roomId}/{eventId} | `PUT /invite/{roomId}/{eventId}` |

## Leaving rooms (ss-core-leaving-rooms-rejecting-invites)

Mapped operations: 2

| operationId   | method | path                           | operationKey                         |
| ------------- | ------ | ------------------------------ | ------------------------------------ |
| `makeLeave`   | `GET`  | /make_leave/{roomId}/{userId}  | `GET /make_leave/{roomId}/{userId}`  |
| `sendLeaveV2` | `PUT`  | /send_leave/{roomId}/{eventId} | `PUT /send_leave/{roomId}/{eventId}` |

## Third-party invites (ss-core-third-party-invites)

Mapped operations: 2

| operationId                  | method | path                                  | operationKey                                |
| ---------------------------- | ------ | ------------------------------------- | ------------------------------------------- |
| `onBindThirdPartyIdentifier` | `PUT`  | /3pid/onbind                          | `PUT /3pid/onbind`                          |
| `exchangeThirdPartyInvite`   | `PUT`  | /exchange_third_party_invite/{roomId} | `PUT /exchange_third_party_invite/{roomId}` |

## Published room directory (ss-core-published-room-directory)

Mapped operations: 2

| operationId        | method | path         | operationKey        |
| ------------------ | ------ | ------------ | ------------------- |
| `getPublicRooms`   | `GET`  | /publicRooms | `GET /publicRooms`  |
| `queryPublicRooms` | `POST` | /publicRooms | `POST /publicRooms` |

## Spaces (ss-core-spaces)

Mapped operations: 1

| operationId         | method | path                | operationKey              |
| ------------------- | ------ | ------------------- | ------------------------- |
| `getSpaceHierarchy` | `GET`  | /hierarchy/{roomId} | `GET /hierarchy/{roomId}` |

## Typing Notifications (ss-core-typing-notifications)

Mapped operations: 0

_No operations mapped yet._

## Presence (ss-core-presence)

Mapped operations: 0

_No operations mapped yet._

## Receipts (ss-core-receipts)

Mapped operations: 0

_No operations mapped yet._

## Querying for information (ss-core-querying-for-information)

Mapped operations: 3

| operationId          | method | path               | operationKey             |
| -------------------- | ------ | ------------------ | ------------------------ |
| `queryInfo`          | `GET`  | /query/{queryType} | `GET /query/{queryType}` |
| `queryRoomDirectory` | `GET`  | /query/directory   | `GET /query/directory`   |
| `queryProfile`       | `GET`  | /query/profile     | `GET /query/profile`     |

## OpenID (ss-core-openid)

Mapped operations: 1

| operationId           | method | path             | operationKey           |
| --------------------- | ------ | ---------------- | ---------------------- |
| `exchangeOpenIdToken` | `GET`  | /openid/userinfo | `GET /openid/userinfo` |

## Device management (ss-core-device-management)

Mapped operations: 1

| operationId      | method | path                   | operationKey                 |
| ---------------- | ------ | ---------------------- | ---------------------------- |
| `getUserDevices` | `GET`  | /user/devices/{userId} | `GET /user/devices/{userId}` |

## End-to-end encryption (ss-core-end-to-end-encryption)

Mapped operations: 2

| operationId               | method | path             | operationKey            |
| ------------------------- | ------ | ---------------- | ----------------------- |
| `claimUserEncryptionKeys` | `POST` | /user/keys/claim | `POST /user/keys/claim` |
| `queryUserEncryptionKeys` | `POST` | /user/keys/query | `POST /user/keys/query` |

## Send-to-device messaging (ss-core-send-to-device-messaging)

Mapped operations: 0

_No operations mapped yet._

## Content repository (ss-core-content-repository)

Mapped operations: 2

| operationId           | method | path                       | operationKey                     |
| --------------------- | ------ | -------------------------- | -------------------------------- |
| `getContent`          | `GET`  | /media/download/{mediaId}  | `GET /media/download/{mediaId}`  |
| `getContentThumbnail` | `GET`  | /media/thumbnail/{mediaId} | `GET /media/thumbnail/{mediaId}` |

## Server ACLs (ss-core-server-access-control-lists-acls)

Mapped operations: 0

_No operations mapped yet._

## Policy servers (ss-core-policy-servers)

Mapped operations: 1

| operationId             | method | path  | operationKey |
| ----------------------- | ------ | ----- | ------------ |
| `askPolicyServerToSign` | `POST` | /sign | `POST /sign` |

## Signing events (ss-core-signing-events)

Mapped operations: 0

_No operations mapped yet._

## Security considerations (ss-core-security-considerations)

Mapped operations: 0

_No operations mapped yet._

<!-- Generated by scripts/spec/generate-speccheck-matrix-v2-endpoint-doc.mjs -->
