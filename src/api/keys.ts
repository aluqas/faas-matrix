// Matrix key management endpoints (E2EE)
// Implements: https://spec.matrix.org/v1.12/client-server-api/#end-to-end-encryption
//
// This module handles:
// - Device key upload/query
// - One-time key management
// - Cross-signing keys (master, self-signing, user-signing)
// - Key change tracking
//
// IMPORTANT: Cross-signing keys use Durable Objects for strong consistency.
// Per the Cloudflare blog: "Some operations can't tolerate eventual consistency"
// D1 has eventual consistency across read replicas, which breaks E2EE bootstrap.

import { Hono } from "hono";
import type { AppEnv } from "../types";
import { Errors } from "../utils/errors";
import { requireAuth } from "../middleware/auth";
import { queueFederationEdu } from "../matrix/application/features/shared/federation-edu-queue";
import { federationPost } from "../services/federation-keys";
import { verifyPassword } from "../utils/crypto";
import { generateOpaqueId, toUserId } from "../utils/ids";
import { runClientEffect } from "../matrix/application/effect-runtime";
import { withLogContext } from "../matrix/application/logging";
import { publishDeviceListUpdateToSharedServers } from "../matrix/application/features/device-lists/command";
import { getSharedServersInRoomsWithUserIncludingPartialState } from "../matrix/application/features/partial-state/shared-servers";
import { parseSyncToken } from "../matrix/application/features/sync/contracts";
import { loadGlobalAccountDataEffect } from "../matrix/application/features/account-data/storage";
import { extractServerNameFromMatrixId } from "../utils/matrix-ids";
import {
  cacheCrossSigningKeys,
  cacheDeviceKeys,
  fetchAllDeviceKeysFromDO,
  fetchCrossSigningKeysFromDO,
  fetchDeviceKeyFromDO,
  loadStoredOneTimeKeyBuckets,
  saveStoredOneTimeKeyBuckets,
  storeCrossSigningKeysToDO,
  storeDeviceKeysToDO,
} from "../matrix/application/features/federation/e2ee-gateway";
import {
  claimFallbackKey,
  claimUnclaimedOneTimeKey,
  hasCrossSigningKeysBackup,
  listCrossSigningSignaturesForKey,
  markStoredOneTimeKeyClaimed,
  recordDeviceKeyChangeWithKysely,
  storeCrossSigningKeysBackup,
  upsertCrossSigningSignature,
  upsertFallbackKeyBackups,
  upsertOneTimeKeyBackups,
} from "../matrix/repositories/federation-e2ee-repository";
import {
  listCurrentMembersInJoinedRooms,
  listNewlySharedUsers,
  listNoLongerSharedUsers,
  listVisibleLocalDeviceKeyChanges,
  listVisibleRemoteDeviceKeyChanges,
} from "../matrix/repositories/keys-query-repository";
import {
  getUserPasswordHash,
  hasIdentityProviderLink,
} from "../matrix/repositories/user-auth-repository";
import {
  type DeviceKeyRequestMap,
  type DeviceKeysPayload,
  type JsonObject,
  type JsonObjectMap,
  type KeysQueryResponse,
  type SignaturesUploadRequest,
  type StringMap,
  type TokenSubmitRequest,
  type UiaSessionData,
  type UserCrossSigningKeyMap,
  type UserDeviceKeysMap,
  type UserOneTimeKeysMap,
  isIdempotentCrossSigningUpload,
  parseCrossSigningUploadRequest,
  parseKeysClaimRequest,
  parseKeysQueryRequest,
  parseKeysQueryResponse,
  parseKeysUploadRequest,
  parseSignaturesUploadRequest,
  parseTokenSubmitRequest,
  parseUiaSessionData,
} from "./keys-contracts";

const app = new Hono<AppEnv>();

function createKeysLogger(operation: string, context: Record<string, unknown> = {}) {
  return withLogContext({
    component: "keys",
    operation,
    debugEnabled: true,
    user_id: typeof context["user_id"] === "string" ? context["user_id"] : undefined,
    device_id: typeof context["device_id"] === "string" ? context["device_id"] : undefined,
  });
}

function parseUiaSessionJson(value: string): UiaSessionData | null {
  try {
    return parseUiaSessionData(JSON.parse(value));
  } catch {
    return null;
  }
}

async function queryRemoteDeviceKeys(
  env: Pick<AppEnv["Bindings"], "SERVER_NAME" | "DB" | "CACHE">,
  requesterUserId: string,
  serverName: string,
  requestedKeys: Record<string, string[]>,
): Promise<{ response: KeysQueryResponse | null; failure?: JsonObject }> {
  const logger = createKeysLogger("query", { user_id: requesterUserId });

  try {
    await runClientEffect(
      logger.info("keys.command.remote_query_start", {
        destination: serverName,
        requested_user_count: Object.keys(requestedKeys).length,
      }),
    );

    const response = await federationPost(
      serverName,
      "/_matrix/federation/v1/user/keys/query",
      { device_keys: requestedKeys },
      env.SERVER_NAME,
      env.DB,
      env.CACHE,
    );

    if (!response.ok) {
      await runClientEffect(
        logger.warn("keys.command.remote_query_failed", {
          destination: serverName,
          status: response.status,
        }),
      );
      return {
        response: null,
        failure: {
          errcode: "M_UNAVAILABLE",
          error: `Remote server ${serverName} returned HTTP ${response.status} for /user/keys/query`,
        },
      };
    }

    const parsed = parseKeysQueryResponse(await response.json().catch(() => null));
    if (!parsed) {
      await runClientEffect(
        logger.warn("keys.command.remote_query_invalid_payload", {
          destination: serverName,
        }),
      );
      return {
        response: null,
        failure: {
          errcode: "M_UNAVAILABLE",
          error: `Remote server ${serverName} returned an invalid /user/keys/query payload`,
        },
      };
    }

    await runClientEffect(
      logger.info("keys.command.remote_query_success", {
        destination: serverName,
        returned_user_count: Object.keys(parsed.device_keys).length,
      }),
    );
    return { response: parsed };
  } catch (error) {
    await runClientEffect(
      logger.error("keys.command.remote_query_error", error, {
        destination: serverName,
      }),
    );
    return {
      response: null,
      failure: {
        errcode: "M_UNAVAILABLE",
        error: `Remote server ${serverName} could not be reached for /user/keys/query`,
      },
    };
  }
}

// ============================================
// Device Keys
// ============================================

// POST /_matrix/client/v3/keys/upload - Upload device keys and one-time keys
app.post("/_matrix/client/v3/keys/upload", requireAuth(), async (c) => {
  const userId = c.get("userId");
  const deviceId = c.get("deviceId");
  const db = c.env.DB;

  if (!userId || !deviceId) {
    return Errors.unauthorized().toResponse();
  }

  const logger = createKeysLogger("upload", { user_id: userId, device_id: deviceId });

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const parsed = parseKeysUploadRequest(body);
  if (!parsed) {
    return Errors.badJson().toResponse();
  }

  const { device_keys, one_time_keys, fallback_keys } = parsed;
  await runClientEffect(
    logger.info("keys.command.start", {
      command: "upload",
      has_device_keys: Boolean(device_keys),
      one_time_key_count: one_time_keys ? Object.keys(one_time_keys).length : 0,
      fallback_key_count: fallback_keys ? Object.keys(fallback_keys).length : 0,
    }),
  );

  // Store device keys with strong consistency
  if (device_keys) {
    // Validate device_keys structure
    await runClientEffect(
      logger.info("keys.command.validate_device_keys", {
        auth_user_id: userId,
        auth_device_id: deviceId,
        body_user_id: device_keys.user_id,
        body_device_id: device_keys.device_id,
      }),
    );

    if (device_keys.user_id !== userId || device_keys.device_id !== deviceId) {
      await runClientEffect(
        logger.warn("keys.command.reject_device_keys", {
          reason: "user_or_device_mismatch",
          body_user_id: device_keys.user_id,
          body_device_id: device_keys.device_id,
        }),
      );
      return c.json(
        {
          errcode: "M_INVALID_PARAM",
          error: `device_keys.user_id and device_keys.device_id must match authenticated user. Got user_id=${device_keys.user_id} (expected ${userId}), device_id=${device_keys.device_id} (expected ${deviceId})`,
        },
        400,
      );
    }

    // Write to Durable Object first (primary - strongly consistent)
    // This is critical for E2EE bootstrap where client uploads then immediately queries
    await storeDeviceKeysToDO(c.env, userId, deviceId, device_keys);

    // Also write to KV as backup/cache
    await cacheDeviceKeys(c.env, userId, deviceId, device_keys);

    // Record key change for /keys/changes
    await recordDeviceKeyChangeWithKysely(db, userId, deviceId, "update");

    // Queue outbound m.device_list_update EDUs to federated servers
    try {
      await publishDeviceListUpdateToSharedServers(
        {
          userId,
          deviceId,
          deviceDisplayName:
            typeof device_keys.unsigned?.["device_display_name"] === "string"
              ? device_keys.unsigned["device_display_name"]
              : undefined,
          keys: device_keys,
        },
        {
          localServerName: c.env.SERVER_NAME,
          now: () => Date.now(),
          getSharedRemoteServers: (sharedUserId) =>
            getSharedServersInRoomsWithUserIncludingPartialState(db, c.env.CACHE, sharedUserId),
          queueEdu: (destination, eduType, content) =>
            queueFederationEdu(c.env, destination, eduType, content),
        },
      );
    } catch (fedErr) {
      await runClientEffect(
        logger.error("keys.command.async_error", fedErr, {
          command: "upload",
          step: "queue_device_list_update",
        }),
      );
    }
  }

  // Store one-time keys in KV for fast access
  const oneTimeKeyCounts: Record<string, number> = {};

  if (one_time_keys) {
    // Get existing keys from KV
    const existingKeys = (await loadStoredOneTimeKeyBuckets(c.env, userId, deviceId)) ?? {};

    for (const [keyId, keyData] of Object.entries(one_time_keys)) {
      const [algorithm] = keyId.split(":");
      if (!algorithm) {
        continue;
      }

      const bucket = existingKeys[algorithm] ?? [];
      if (!existingKeys[algorithm]) {
        existingKeys[algorithm] = bucket;
      }

      // Check if key already exists
      const existingIndex = bucket.findIndex((storedKey) => storedKey.keyId === keyId);
      if (existingIndex >= 0) {
        bucket[existingIndex] = { keyId, keyData, claimed: false };
      } else {
        bucket.push({ keyId, keyData, claimed: false });
      }
    }

    await upsertOneTimeKeyBackups(db, userId, deviceId, one_time_keys);

    // Save back to KV
    await saveStoredOneTimeKeyBuckets(c.env, userId, deviceId, existingKeys);

    // Count unclaimed keys
    for (const [algorithm, keys] of Object.entries(existingKeys)) {
      oneTimeKeyCounts[algorithm] = keys.filter((k) => !k.claimed).length;
    }
  } else {
    // Just get counts from KV
    const parsedExistingKeys = await loadStoredOneTimeKeyBuckets(c.env, userId, deviceId);

    if (parsedExistingKeys) {
      for (const [algorithm, keys] of Object.entries(parsedExistingKeys)) {
        oneTimeKeyCounts[algorithm] = keys.filter((k) => !k.claimed).length;
      }
    }
  }

  // Store fallback keys
  if (fallback_keys) {
    await upsertFallbackKeyBackups(db, userId, deviceId, fallback_keys);
  }

  await runClientEffect(
    logger.info("keys.command.success", {
      command: "upload",
      one_time_algorithms: Object.keys(oneTimeKeyCounts).length,
    }),
  );

  return c.json({
    one_time_key_counts: oneTimeKeyCounts,
  });
});

// POST /_matrix/client/v3/keys/query - Query device keys for users
app.post("/_matrix/client/v3/keys/query", requireAuth(), async (c) => {
  const db = c.env.DB;
  const requesterUserId = c.get("userId");
  const logger = createKeysLogger("query", { user_id: requesterUserId });

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const parsed = parseKeysQueryRequest(body);
  if (!parsed) {
    return Errors.badJson().toResponse();
  }

  const { device_keys: requestedKeys } = parsed;
  await runClientEffect(
    logger.info("keys.command.start", {
      command: "query",
      requested_user_count: requestedKeys ? Object.keys(requestedKeys).length : 0,
    }),
  );

  const deviceKeys: UserDeviceKeysMap = {};
  const masterKeys: UserCrossSigningKeyMap = {};
  const selfSigningKeys: UserCrossSigningKeyMap = {};
  const userSigningKeys: UserCrossSigningKeyMap = {};
  const failures: JsonObjectMap = {};

  // Helper function to merge signatures from DB into device keys
  async function mergeSignaturesForDevice(
    userId: string,
    deviceId: string,
    deviceKey: DeviceKeysPayload,
  ): Promise<DeviceKeysPayload> {
    // Get additional signatures from the database
    const dbSignatures = await listCrossSigningSignaturesForKey(db, userId, deviceId);

    if (dbSignatures.length > 0) {
      const mergedSignatures: Record<string, StringMap> = deviceKey.signatures
        ? { ...deviceKey.signatures }
        : {};
      for (const sig of dbSignatures) {
        mergedSignatures[sig.signerUserId] = mergedSignatures[sig.signerUserId] || {};
        mergedSignatures[sig.signerUserId][sig.signerKeyId] = sig.signature;
      }
      deviceKey.signatures = mergedSignatures;
    }

    return deviceKey;
  }

  if (requestedKeys) {
    const localServerName = c.env.SERVER_NAME;
    const remoteRequestsByServer: Record<string, DeviceKeyRequestMap> = {};

    for (const [userId, devices] of Object.entries(requestedKeys)) {
      const typedUserId = toUserId(userId);
      if (!typedUserId) {
        continue;
      }
      deviceKeys[typedUserId] = {};
      const userServerName = extractServerNameFromMatrixId(typedUserId);
      if (userServerName && userServerName !== localServerName) {
        remoteRequestsByServer[userServerName] = remoteRequestsByServer[userServerName] || {};
        remoteRequestsByServer[userServerName][typedUserId] = devices;
        continue;
      }

      // Get device keys from Durable Object (strongly consistent)
      // Critical for E2EE bootstrap where client uploads then immediately queries
      const requestedDevices = Array.isArray(devices) && devices.length > 0 ? devices : null;

      if (requestedDevices === null || requestedDevices.length === 0) {
        // Get all devices for this user from Durable Object
        const allDeviceKeys = await fetchAllDeviceKeysFromDO(c.env, typedUserId);
        for (const [deviceId, keys] of Object.entries(allDeviceKeys)) {
          if (keys) {
            // Merge DB signatures into the device keys
            deviceKeys[typedUserId][deviceId] = await mergeSignaturesForDevice(
              typedUserId,
              deviceId,
              keys,
            );
          }
        }
      } else {
        // Get specific devices from Durable Object
        for (const deviceId of requestedDevices) {
          const keys = await fetchDeviceKeyFromDO(c.env, typedUserId, deviceId);
          if (keys) {
            // Merge DB signatures into the device keys
            deviceKeys[typedUserId][deviceId] = await mergeSignaturesForDevice(
              typedUserId,
              deviceId,
              keys,
            );
          }
        }
      }

      // Get cross-signing keys from Durable Object (strongly consistent)
      // Per Cloudflare blog: D1 has eventual consistency across read replicas.
      // Durable Objects provide single-threaded, atomic storage - critical for
      // E2EE bootstrap where client uploads then immediately queries keys.
      const csKeys = await fetchCrossSigningKeysFromDO(c.env, typedUserId);

      if (csKeys.master) {
        masterKeys[typedUserId] = csKeys.master;
      }
      if (csKeys.self_signing) {
        selfSigningKeys[typedUserId] = csKeys.self_signing;
      }
      // Only return user_signing key if querying own keys
      if (csKeys.user_signing && typedUserId === requesterUserId) {
        userSigningKeys[typedUserId] = csKeys.user_signing;
      }
    }

    for (const [serverName, remoteRequests] of Object.entries(remoteRequestsByServer)) {
      const { response, failure } = await queryRemoteDeviceKeys(
        c.env,
        requesterUserId,
        serverName,
        remoteRequests,
      );

      if (failure) {
        failures[serverName] = failure;
        continue;
      }
      if (!response) {
        continue;
      }

      for (const [userId, remoteDeviceMap] of Object.entries(response.device_keys)) {
        const typedUserId = toUserId(userId);
        if (!typedUserId) {
          continue;
        }
        deviceKeys[typedUserId] = {
          ...deviceKeys[typedUserId],
          ...remoteDeviceMap,
        };
      }
      Object.assign(masterKeys, response.master_keys ?? {});
      Object.assign(selfSigningKeys, response.self_signing_keys ?? {});
    }
  }

  await runClientEffect(
    logger.info("keys.command.success", {
      command: "query",
      returned_user_count: Object.keys(deviceKeys).length,
    }),
  );

  return c.json({
    device_keys: deviceKeys,
    master_keys: masterKeys,
    self_signing_keys: selfSigningKeys,
    user_signing_keys: userSigningKeys,
    failures,
  });
});

// POST /_matrix/client/v3/keys/claim - Claim one-time keys for establishing sessions
app.post("/_matrix/client/v3/keys/claim", requireAuth(), async (c) => {
  const db = c.env.DB;
  const logger = createKeysLogger("claim", { user_id: c.get("userId") });

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const parsed = parseKeysClaimRequest(body);
  if (!parsed) {
    return Errors.badJson().toResponse();
  }

  const { one_time_keys: requestedKeys } = parsed;
  await runClientEffect(
    logger.info("keys.command.start", {
      command: "claim",
      requested_user_count: requestedKeys ? Object.keys(requestedKeys).length : 0,
    }),
  );

  const oneTimeKeys: UserOneTimeKeysMap = {};
  const failures: JsonObjectMap = {};

  if (requestedKeys) {
    for (const [userId, devices] of Object.entries(requestedKeys)) {
      const typedUserId = toUserId(userId);
      if (!typedUserId) {
        continue;
      }
      oneTimeKeys[typedUserId] = {};

      for (const [deviceId, algorithm] of Object.entries(devices)) {
        // Try to claim a one-time key from KV first
        const existingKeys = await loadStoredOneTimeKeyBuckets(c.env, typedUserId, deviceId);

        let foundKey = false;

        const bucket = existingKeys?.[algorithm];
        if (bucket) {
          // Find first unclaimed key
          const keyIndex = bucket.findIndex((storedKey) => !storedKey.claimed);
          if (keyIndex >= 0) {
            const key = bucket[keyIndex];
            if (!key) {
              continue;
            }
            // Mark as claimed
            bucket[keyIndex] = { ...key, claimed: true };

            // Save back to KV
            await saveStoredOneTimeKeyBuckets(c.env, typedUserId, deviceId, existingKeys);

            // Also mark in D1
            await markStoredOneTimeKeyClaimed(db, typedUserId, deviceId, key.keyId, Date.now());

            oneTimeKeys[typedUserId][deviceId] = {
              [key.keyId]: key.keyData,
            };
            foundKey = true;
          }
        }

        if (!foundKey) {
          // Fallback to D1 for legacy keys
          const otk = await claimUnclaimedOneTimeKey(
            db,
            typedUserId,
            deviceId,
            algorithm,
            Date.now(),
          );

          if (otk) {
            oneTimeKeys[typedUserId][deviceId] = {
              [otk.keyId]: otk.keyData,
            };
            foundKey = true;
          }
        }

        if (!foundKey) {
          // Try fallback key
          const fallback = await claimFallbackKey(db, typedUserId, deviceId, algorithm);

          if (fallback) {
            oneTimeKeys[typedUserId][deviceId] = {
              [fallback.keyId]: {
                ...fallback.keyData,
                fallback: true,
              },
            };
          }
        }
      }
    }
  }

  await runClientEffect(
    logger.info("keys.command.success", {
      command: "claim",
      returned_user_count: Object.keys(oneTimeKeys).length,
    }),
  );

  return c.json({
    one_time_keys: oneTimeKeys,
    failures,
  });
});

// GET /_matrix/client/v3/keys/changes - Get users whose keys have changed
app.get("/_matrix/client/v3/keys/changes", requireAuth(), async (c) => {
  const userId = c.get("userId");
  const from = c.req.query("from");
  const to = c.req.query("to");
  const db = c.env.DB;

  if (!userId) {
    return Errors.unauthorized().toResponse();
  }

  if (!from || !to) {
    return Errors.missingParam("from and to required").toResponse();
  }

  const fromToken = parseSyncToken(from);
  const toToken = parseSyncToken(to);
  const fromEventPosition = fromToken.events;
  const toEventPosition = toToken.events;
  const fromDeviceKeyPosition = fromToken.deviceKeys;
  const toDeviceKeyPosition = toToken.deviceKeys;

  const [localChanged, remoteChanged, newlyShared, currentMembersInJoinedRooms, noLongerShared] =
    await Promise.all([
      listVisibleLocalDeviceKeyChanges(db, userId, fromDeviceKeyPosition, toDeviceKeyPosition),
      listVisibleRemoteDeviceKeyChanges(db, userId, fromDeviceKeyPosition, toDeviceKeyPosition),
      listNewlySharedUsers(db, userId, fromEventPosition, toEventPosition),
      listCurrentMembersInJoinedRooms(db, userId, fromEventPosition, toEventPosition),
      listNoLongerSharedUsers(db, userId, fromEventPosition, toEventPosition),
    ]);

  const changed = new Set<string>();
  const left = new Set<string>();

  for (const change of localChanged) {
    if (change.change_type === "delete") {
      left.add(change.user_id);
    } else {
      changed.add(change.user_id);
    }
  }
  for (const row of remoteChanged) {
    changed.add(row.user_id);
  }
  for (const row of newlyShared) {
    changed.add(row.user_id);
  }
  for (const row of currentMembersInJoinedRooms) {
    changed.add(row.user_id);
  }
  for (const row of noLongerShared) {
    if (!changed.has(row.user_id)) {
      left.add(row.user_id);
    }
  }

  return c.json({
    changed: [...changed],
    left: [...left],
  });
});

// ============================================
// Cross-Signing Keys
// ============================================

// Helper: Check if user has OIDC/SSO link (logged in via external IdP)
function isOIDCUser(db: D1Database, userId: string): Promise<boolean> {
  const typedUserId = toUserId(userId);
  if (!typedUserId) {
    return Promise.resolve(false);
  }

  return hasIdentityProviderLink(db, typedUserId);
}

// Helper: Check if user has password set
async function hasPassword(db: D1Database, userId: string): Promise<boolean> {
  const typedUserId = toUserId(userId);
  if (!typedUserId) {
    return false;
  }

  const hash = await getUserPasswordHash(db, typedUserId);
  return hash !== null && hash.length > 0;
}

// POST /_matrix/client/v3/keys/device_signing/upload - Upload cross-signing keys
// Spec: https://spec.matrix.org/v1.12/client-server-api/#post_matrixclientv3keysdevice_signingupload
// This endpoint requires UIA (User-Interactive Authentication)
//
// For OIDC users (users linked to external IdP), we support:
// - m.login.sso: Redirect to OAuth authorize for re-authentication
// - m.login.token: Token-based authentication (fallback)
// For password users, we support:
// - m.login.password: Password-based authentication
app.post("/_matrix/client/v3/keys/device_signing/upload", requireAuth(), async (c) => {
  const userId = c.get("userId");
  const db = c.env.DB;

  if (!userId) {
    return Errors.unauthorized().toResponse();
  }

  const logger = createKeysLogger("device_signing_upload", { user_id: userId });

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const parsed = parseCrossSigningUploadRequest(body);
  if (!parsed) {
    return Errors.badJson().toResponse();
  }

  const { master_key, self_signing_key, user_signing_key, auth } = parsed;
  await runClientEffect(
    logger.info("keys.command.start", {
      command: "device_signing_upload",
      has_master_key: Boolean(master_key),
      has_self_signing_key: Boolean(self_signing_key),
      has_user_signing_key: Boolean(user_signing_key),
      auth_type: auth?.type,
    }),
  );

  // Check if user already has cross-signing keys set up
  const hasExistingKeys = await hasCrossSigningKeysBackup(db, userId);
  const existingCSKeys = hasExistingKeys ? await fetchCrossSigningKeysFromDO(c.env, userId) : {};
  const uploadRequest = {
    ...(master_key ? { master_key } : {}),
    ...(self_signing_key ? { self_signing_key } : {}),
    ...(user_signing_key ? { user_signing_key } : {}),
    ...(auth ? { auth } : {}),
  };
  const isIdempotentUpload =
    hasExistingKeys && isIdempotentCrossSigningUpload(existingCSKeys, uploadRequest);
  await runClientEffect(
    logger.info("keys.command.auth_context", {
      has_existing_keys: hasExistingKeys,
      is_idempotent_upload: isIdempotentUpload,
    }),
  );

  // Check user's authentication capabilities
  const userIsOIDC = await isOIDCUser(db, userId);
  const userHasPassword = await hasPassword(db, userId);
  // Log auth method type without exposing sensitive details
  await runClientEffect(
    logger.info("keys.command.auth_context", {
      is_oidc_user: userIsOIDC,
      has_password: userHasPassword,
    }),
  );

  // MSC3967: Do not require UIA when first uploading cross-signing keys
  // Per Matrix spec v1.11+, if user has NO existing cross-signing keys, skip UIA for first-time setup
  // If user HAS existing keys, require authentication
  if (!hasExistingKeys || isIdempotentUpload) {
    // First-time cross-signing setup - skip UIA per MSC3967
    await runClientEffect(
      logger.info("keys.command.uia_skipped", {
        reason: hasExistingKeys ? "idempotent_reupload" : "first_time_setup",
      }),
    );
  } else if (!auth) {
    // User has existing keys but no auth provided - return UIA challenge
    const sessionId = await generateOpaqueId(16);

    // Build available flows based on user's authentication method
    const flows: Array<{ stages: string[] }> = [];
    const serverName = c.env.SERVER_NAME;
    const baseUrl = `https://${serverName}`;
    const params: Record<string, JsonObject> = {};

    if (userIsOIDC) {
      // OIDC users: Use org.matrix.cross_signing_reset per MSC4312
      // This is the unstable identifier; stable is m.oauth
      // Per MSC4312: "To prevent breaking clients that have implemented the unstable identifier,
      // servers SHOULD offer two flows (one with each of m.oauth and org.matrix.cross_signing_reset)"
      const unstableStage = "org.matrix.cross_signing_reset";
      const stableStage = "m.oauth";

      // Offer both flows for compatibility during migration
      flows.push({ stages: [unstableStage] });
      flows.push({ stages: [stableStage] });

      // The URL points to authorization server's account management UI
      // where the user can approve the cross-signing reset
      const approvalUrl = `${baseUrl}/oauth/authorize/uia?session=${sessionId}&action=org.matrix.cross_signing_reset`;

      // Both stages use the same params with 'url' pointing to approval page
      params[unstableStage] = { url: approvalUrl };
      params[stableStage] = { url: approvalUrl };
    }

    if (userHasPassword) {
      // Password users: Offer password flow
      flows.push({ stages: ["m.login.password"] });
    }

    // Fallback: If user has neither (shouldn't happen), offer password flow
    if (flows.length === 0) {
      flows.push({ stages: ["m.login.password"] });
    }

    // Store session in KV for validation
    await c.env.CACHE.put(
      `uia_session:${sessionId}`,
      JSON.stringify({
        user_id: userId,
        created_at: Date.now(),
        type: "device_signing_upload",
        completed_stages: [],
        is_oidc_user: userIsOIDC,
        has_password: userHasPassword,
      }),
      { expirationTtl: 300 }, // 5 minute session
    );

    await runClientEffect(
      logger.info("keys.command.uia_required", {
        session_id: sessionId,
        flow_count: flows.length,
      }),
    );

    // Return UIA challenge
    return c.json(
      {
        flows,
        params,
        session: sessionId,
      },
      401,
    );
  } else {
    // Auth provided for key replacement - validate it
    await runClientEffect(
      logger.info("keys.command.auth_validate", {
        auth_type: auth.type,
      }),
    );

    if (auth.type === "m.login.password") {
      // Validate password
      const typedUserId = toUserId(userId);
      if (!typedUserId) {
        return Errors.unauthorized().toResponse();
      }

      const storedHash = await getUserPasswordHash(db, typedUserId);
      if (!storedHash) {
        await runClientEffect(
          logger.warn("keys.command.auth_reject", {
            reason: "missing_password_hash",
          }),
        );
        return Errors.forbidden("No password set for user").toResponse();
      }

      if (!auth.password) {
        await runClientEffect(
          logger.warn("keys.command.auth_reject", {
            reason: "missing_password",
          }),
        );
        return Errors.missingParam("auth.password").toResponse();
      }

      const valid = await verifyPassword(auth.password, storedHash);
      if (!valid) {
        await runClientEffect(
          logger.warn("keys.command.auth_reject", {
            reason: "invalid_password",
          }),
        );
        return Errors.forbidden("Invalid password").toResponse();
      }

      await runClientEffect(
        logger.info("keys.command.auth_success", {
          auth_type: auth.type,
        }),
      );
    } else if (
      auth.type === "org.matrix.cross_signing_reset" ||
      auth.type === "m.oauth" ||
      auth.type === "m.login.oauth" ||
      auth.type === "m.login.sso" ||
      auth.type === "m.login.token" ||
      !auth.type
    ) {
      // MSC4312 cross-signing reset flow for OIDC users
      // Supports:
      // - org.matrix.cross_signing_reset (unstable per MSC4312)
      // - m.oauth (stable per MSC4312)
      // - m.login.oauth, m.login.sso, m.login.token (legacy compatibility)
      // - No type at all (per MSC4312: client just sends session)

      const sessionId = auth.session;
      if (!sessionId) {
        await runClientEffect(
          logger.warn("keys.command.auth_reject", {
            reason: "missing_session",
          }),
        );
        return Errors.missingParam("auth.session").toResponse();
      }

      const sessionJson = await c.env.CACHE.get(`uia_session:${sessionId}`);
      if (!sessionJson) {
        await runClientEffect(
          logger.warn("keys.command.auth_reject", {
            reason: "session_not_found",
            session_id: sessionId,
          }),
        );
        return c.json(
          {
            errcode: "M_UNKNOWN",
            error: "UIA session not found or expired",
          },
          401,
        );
      }

      const session = parseUiaSessionJson(sessionJson);
      if (!session) {
        await runClientEffect(
          logger.warn("keys.command.auth_reject", {
            reason: "invalid_session_payload",
            session_id: sessionId,
          }),
        );
        return Errors.unknown("Invalid UIA session payload").toResponse();
      }

      // Check if session belongs to this user
      if (session.user_id !== userId) {
        await runClientEffect(
          logger.warn("keys.command.auth_reject", {
            reason: "session_user_mismatch",
            session_id: sessionId,
          }),
        );
        return Errors.forbidden("Session user mismatch").toResponse();
      }

      // Check if the cross-signing reset has been approved via OAuth flow
      // Accept all stage names that indicate completion
      const completedStages = session.completed_stages || [];
      const hasOAuthApproval =
        completedStages.includes("org.matrix.cross_signing_reset") ||
        completedStages.includes("m.oauth") ||
        completedStages.includes("m.login.oauth") ||
        completedStages.includes("m.login.sso") ||
        completedStages.includes("m.login.token");

      if (!hasOAuthApproval) {
        await runClientEffect(
          logger.warn("keys.command.auth_reject", {
            reason: "oauth_approval_missing",
            session_id: sessionId,
          }),
        );
        return c.json(
          {
            errcode: "M_UNAUTHORIZED",
            error:
              "Cross-signing reset not approved. Please approve the request at the provided URL.",
          },
          401,
        );
      }

      await runClientEffect(
        logger.info("keys.command.auth_success", {
          auth_type: auth.type ?? "session_only",
          session_id: sessionId,
        }),
      );

      // Clean up the session
      await c.env.CACHE.delete(`uia_session:${sessionId}`);
    } else {
      // Unknown auth type
      await runClientEffect(
        logger.warn("keys.command.auth_reject", {
          reason: "unknown_auth_type",
          auth_type: auth.type,
        }),
      );
      return c.json(
        {
          errcode: "M_UNRECOGNIZED",
          error: `Unrecognized auth type: ${auth.type}`,
        },
        400,
      );
    }
  }

  // UIA passed - check if SSSS is set up (for logging purposes only)
  // We allow cross-signing key uploads even without SSSS, as Element X may set up
  // SSSS immediately after uploading cross-signing keys during the bootstrap flow.
  // The "confirm your identity" screen in Element X is EXPECTED for new users -
  // it prompts them to set up recovery/SSSS.
  const typedUserId = toUserId(userId);
  if (!typedUserId) {
    return Errors.unauthorized().toResponse();
  }

  const ssssDefault = await runClientEffect(
    loadGlobalAccountDataEffect(c.env, typedUserId, "m.secret_storage.default_key"),
  );
  const hasValidSSS = !!ssssDefault?.["key"];

  if (!hasValidSSS) {
    // SSSS is not set up yet - this is OK, Element X will prompt user to set up recovery
    // Cross-signing keys can be uploaded before SSSS during initial bootstrap
    await runClientEffect(
      logger.info("keys.command.ssss_state", {
        has_valid_ssss: false,
      }),
    );
  } else {
    await runClientEffect(
      logger.info("keys.command.ssss_state", {
        has_valid_ssss: true,
      }),
    );
  }

  // Get existing keys from Durable Object (strongly consistent)
  // Merge new keys with existing
  const csKeys = { ...existingCSKeys };
  if (master_key) csKeys.master = master_key;
  if (self_signing_key) csKeys.self_signing = self_signing_key;
  if (user_signing_key) csKeys.user_signing = user_signing_key;

  // Write to Durable Object (primary - strongly consistent)
  // This is critical for E2EE bootstrap where client uploads then immediately queries
  await storeCrossSigningKeysToDO(c.env, userId, csKeys);
  await runClientEffect(
    logger.info("keys.command.success", {
      command: "device_signing_upload",
      has_master_key: Boolean(master_key),
      has_self_signing_key: Boolean(self_signing_key),
      has_user_signing_key: Boolean(user_signing_key),
    }),
  );

  // Also write to D1 as backup (for durability/recovery)
  // These writes are eventually consistent but serve as backup storage
  await storeCrossSigningKeysBackup(db, userId, csKeys, Boolean(master_key));

  // Write to KV as cache (eventually consistent, for performance)
  await cacheCrossSigningKeys(c.env, userId, csKeys);

  return c.json({});
});

// POST /_matrix/client/v3/keys/signatures/upload - Upload signatures for keys
// Spec: https://spec.matrix.org/v1.12/client-server-api/#post_matrixclientv3keyssignaturesupload
// Body format: { user_id: { key_id: signed_key_object } }
// - For device keys, key_id is the device_id (e.g., "JLAFKJWSCS")
// - For cross-signing keys, key_id is the base64 public key
app.post("/_matrix/client/v3/keys/signatures/upload", requireAuth(), async (c) => {
  const signerUserId = c.get("userId");
  const db = c.env.DB;
  const logger = createKeysLogger("signatures_upload", { user_id: signerUserId });

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const parsedBody: SignaturesUploadRequest | null = parseSignaturesUploadRequest(body);
  if (!parsedBody) {
    return Errors.badJson().toResponse();
  }

  await runClientEffect(
    logger.info("keys.command.start", {
      command: "signatures_upload",
      target_user_count: Object.keys(parsedBody).length,
    }),
  );

  // body is a map of user_id -> key_id -> signed_key_object
  const failures: Record<string, Record<string, { errcode: string; error: string }>> = {};

  for (const [userId, keys] of Object.entries(parsedBody)) {
    for (const [keyId, signedKeyObj] of Object.entries(keys)) {
      try {
        // Extract signatures from the signed key object
        const signatures = signedKeyObj.signatures?.[signerUserId] ?? {};

        await runClientEffect(
          logger.info("keys.command.signature_process", {
            target_user_id: userId,
            key_id: keyId,
            has_device_id: Boolean(signedKeyObj.device_id),
            signature_count: Object.keys(signatures).length,
          }),
        );

        // Store all signatures in the database
        for (const [signerKeyId, signature] of Object.entries(signatures)) {
          // Use the device_id as key_id for device keys, otherwise use the provided keyId
          const effectiveKeyId = signedKeyObj.device_id ?? keyId;

          await upsertCrossSigningSignature(
            db,
            userId,
            effectiveKeyId,
            signerUserId,
            signerKeyId,
            signature,
          );
        }

        // If this is a device key (has device_id field), update the device key in KV
        if (signedKeyObj.device_id) {
          const deviceId = signedKeyObj.device_id;

          // Read from Durable Object (strongly consistent)
          const existingKey = await fetchDeviceKeyFromDO(c.env, userId, deviceId);

          if (existingKey) {
            // Merge new signatures into existing signatures
            existingKey.signatures = existingKey.signatures ?? {};
            existingKey.signatures[signerUserId] = {
              ...existingKey.signatures[signerUserId],
              ...signatures,
            };

            // Write to Durable Object (primary - strongly consistent)
            await storeDeviceKeysToDO(c.env, userId, deviceId, existingKey);

            // Also update KV as backup/cache
            await cacheDeviceKeys(c.env, userId, deviceId, existingKey);
          } else {
            await runClientEffect(
              logger.warn("keys.command.signature_missing_device", {
                target_user_id: userId,
                device_id: deviceId,
              }),
            );
          }
        }

        // Record key change for sync notifications
        await recordDeviceKeyChangeWithKysely(db, userId, signedKeyObj.device_id ?? null, "update");
      } catch (err) {
        await runClientEffect(
          logger.error("keys.command.error", err, {
            command: "signatures_upload",
            target_user_id: userId,
            key_id: keyId,
          }),
        );
        if (!failures[userId]) failures[userId] = {};
        failures[userId][keyId] = {
          errcode: "M_UNKNOWN",
          error: "Failed to store signature",
        };
      }
    }
  }

  await runClientEffect(
    logger.info("keys.command.success", {
      command: "signatures_upload",
      failure_count: Object.keys(failures).length,
    }),
  );
  return c.json({ failures });
});

// ============================================
// UIA SSO Flow Endpoints (for OIDC users)
// ============================================

// GET /_matrix/client/v3/auth/m.login.sso/redirect - Redirect to SSO for UIA
// This endpoint is used by clients to initiate SSO authentication during UIA
// Spec: https://spec.matrix.org/v1.12/client-server-api/#get_matrixclientv3authmlloginssofallbackweb
app.get("/_matrix/client/v3/auth/m.login.sso/redirect", async (c) => {
  const logger = createKeysLogger("uia_sso_redirect");
  const sessionId = c.req.query("session");
  const redirectUrl = c.req.query("redirectUrl");

  if (!sessionId) {
    return c.json(
      {
        errcode: "M_MISSING_PARAM",
        error: "Missing session parameter",
      },
      400,
    );
  }

  // Verify the UIA session exists
  const sessionJson = await c.env.CACHE.get(`uia_session:${sessionId}`);
  if (!sessionJson) {
    return c.json(
      {
        errcode: "M_UNKNOWN",
        error: "UIA session not found or expired",
      },
      404,
    );
  }

  const session = parseUiaSessionJson(sessionJson);
  if (!session) {
    return Errors.unknown("Invalid UIA session payload").toResponse();
  }
  const serverName = c.env.SERVER_NAME;
  const baseUrl = `https://${serverName}`;

  // Store the redirect URL for after SSO completes
  session.redirect_url = redirectUrl ?? `${baseUrl}/_matrix/client/v3/auth/m.login.sso/callback`;
  await c.env.CACHE.put(`uia_session:${sessionId}`, JSON.stringify(session), {
    expirationTtl: 300,
  });

  // Redirect to OAuth authorize endpoint for re-authentication
  // The user must authenticate with their IdP to complete the UIA flow
  const authorizeUrl = new URL(`${baseUrl}/oauth/authorize`);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("client_id", "matrix-uia");
  authorizeUrl.searchParams.set(
    "redirect_uri",
    `${baseUrl}/_matrix/client/v3/auth/m.login.sso/callback`,
  );
  authorizeUrl.searchParams.set("scope", "openid");
  authorizeUrl.searchParams.set("state", sessionId);

  await runClientEffect(
    logger.info("keys.command.start", {
      command: "uia_sso_redirect",
      session_id: sessionId,
    }),
  );
  return c.redirect(authorizeUrl.toString());
});

// GET /_matrix/client/v3/auth/m.login.sso/callback - SSO callback for UIA
// This endpoint handles the return from SSO authentication
app.get("/_matrix/client/v3/auth/m.login.sso/callback", async (c) => {
  const logger = createKeysLogger("uia_sso_callback");
  const code = c.req.query("code");
  const state = c.req.query("state"); // This is the UIA session ID
  const error = c.req.query("error");
  const errorDescription = c.req.query("error_description");

  if (error) {
    await runClientEffect(
      logger.warn("keys.command.sso_error", {
        error_code: error,
        error_description: errorDescription,
      }),
    );
    return c.html(generateSSOErrorPage("SSO Authentication Failed", errorDescription ?? error));
  }

  if (!state) {
    return c.html(generateSSOErrorPage("Invalid Request", "Missing state parameter"));
  }

  // Retrieve the UIA session
  const sessionJson = await c.env.CACHE.get(`uia_session:${state}`);
  if (!sessionJson) {
    return c.html(
      generateSSOErrorPage("Session Expired", "The UIA session has expired. Please try again."),
    );
  }

  const session = parseUiaSessionJson(sessionJson);
  if (!session) {
    return c.html(generateSSOErrorPage("Session Invalid", "The UIA session payload is invalid."));
  }

  // If code is present, SSO was successful
  // For UIA purposes, we just need to verify the user authenticated - we don't need the token
  if (code) {
    // Mark SSO as completed in the session
    session.completed_stages = session.completed_stages || [];
    if (!session.completed_stages.includes("m.login.sso")) {
      session.completed_stages.push("m.login.sso");
    }
    session.sso_completed_at = Date.now();

    // Save updated session
    await c.env.CACHE.put(`uia_session:${state}`, JSON.stringify(session), { expirationTtl: 300 });

    await runClientEffect(
      logger.info("keys.command.success", {
        command: "uia_sso_callback",
        session_id: state,
      }),
    );

    // Return success page that tells the client to retry the original request
    return c.html(generateSSOSuccessPage(state, session.redirect_url));
  }

  return c.html(generateSSOErrorPage("Authentication Failed", "No authorization code received"));
});

// POST /_matrix/client/v3/auth/m.login.token/submit - Submit token for UIA
// Alternative flow for OIDC users who have a valid token
app.post("/_matrix/client/v3/auth/m.login.token/submit", requireAuth(), async (c) => {
  const userId = c.get("userId");
  const logger = createKeysLogger("uia_token_submit", { user_id: userId });

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return Errors.badJson().toResponse();
  }

  const parsed: TokenSubmitRequest | null = parseTokenSubmitRequest(body);
  if (!parsed) {
    return Errors.badJson().toResponse();
  }

  const { session } = parsed;

  if (!session) {
    return Errors.missingParam("session").toResponse();
  }

  // Retrieve the UIA session
  const sessionJson = await c.env.CACHE.get(`uia_session:${session}`);
  if (!sessionJson) {
    return c.json(
      {
        errcode: "M_UNKNOWN",
        error: "UIA session not found or expired",
      },
      404,
    );
  }

  const sessionData = parseUiaSessionJson(sessionJson);
  if (!sessionData) {
    return Errors.unknown("Invalid UIA session payload").toResponse();
  }

  // Verify the session belongs to this user
  if (sessionData.user_id !== userId) {
    return Errors.forbidden("Session user mismatch").toResponse();
  }

  // The user is already authenticated with a valid access token
  // This is sufficient for token-based UIA completion
  sessionData.completed_stages = sessionData.completed_stages || [];
  if (!sessionData.completed_stages.includes("m.login.token")) {
    sessionData.completed_stages.push("m.login.token");
  }
  sessionData.token_completed_at = Date.now();

  // Save updated session
  await c.env.CACHE.put(`uia_session:${session}`, JSON.stringify(sessionData), {
    expirationTtl: 300,
  });

  await runClientEffect(
    logger.info("keys.command.success", {
      command: "uia_token_submit",
      session_id: session,
    }),
  );

  return c.json({
    completed: ["m.login.token"],
    session,
  });
});

// Helper: Generate SSO error page
function generateSSOErrorPage(title: string, message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #f1f5f9; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .container { background: #1e293b; padding: 40px; border-radius: 12px; max-width: 400px; text-align: center; border: 1px solid #334155; }
    h1 { color: #ef4444; margin-bottom: 16px; }
    p { color: #94a3b8; margin-bottom: 24px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>${title}</h1>
    <p>${message}</p>
    <p>You can close this window and try again.</p>
  </div>
</body>
</html>`;
}

// Helper: Generate SSO success page
function generateSSOSuccessPage(sessionId: string, _redirectUrl?: string): string {
  // Note: _redirectUrl is reserved for future use when we support custom redirects
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authentication Successful</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #f1f5f9; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
    .container { background: #1e293b; padding: 40px; border-radius: 12px; max-width: 400px; text-align: center; border: 1px solid #334155; }
    h1 { color: #22c55e; margin-bottom: 16px; }
    p { color: #94a3b8; margin-bottom: 24px; }
    .session { font-family: monospace; background: #0f172a; padding: 8px 16px; border-radius: 8px; font-size: 12px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authentication Successful</h1>
    <p>Your identity has been verified.</p>
    <p>You can now return to your Matrix client and complete the operation.</p>
    <p class="session">Session: ${sessionId}</p>
    <script>
      // Try to notify the parent window/opener if this was opened as a popup
      if (window.opener) {
        window.opener.postMessage({ type: 'uia_complete', session: '${sessionId}' }, '*');
        setTimeout(() => window.close(), 2000);
      }
    </script>
  </div>
</body>
</html>`;
}

export default app;
