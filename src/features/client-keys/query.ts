import type { AppEnv } from "../../shared/types";
import { runClientEffect } from "../../matrix/application/runtime/effect-runtime";
import { federationPost } from "../../infra/federation/federation-keys";
import { extractServerNameFromMatrixId } from "../../shared/utils/matrix-ids";
import { toUserId } from "../../shared/utils/ids";
import {
  fetchAllDeviceKeysFromDO,
  fetchCrossSigningKeysFromDO,
  fetchDeviceKeyFromDO,
} from "../e2ee-shared/gateway";
import { listCrossSigningSignaturesForKey } from "../../infra/repositories/e2ee-repository";
import {
  listCurrentMembersInJoinedRooms,
  listNewlySharedUsers,
  listNoLongerSharedUsers,
  listVisibleLocalDeviceKeyChanges,
  listVisibleRemoteDeviceKeyChanges,
} from "../../infra/repositories/keys-query-repository";
import { parseSyncToken } from "../sync/contracts";
import type {
  DeviceKeyRequestMap,
  DeviceKeysPayload,
  JsonObject,
  JsonObjectMap,
  KeysQueryRequest,
  KeysQueryResponse,
  StringMap,
  UserCrossSigningKeyMap,
  UserDeviceKeysMap,
} from "../../shared/types/client";
import { parseKeysQueryResponse } from "../../api/keys-contracts";
import { createKeysLogger } from "./shared";

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

async function mergeSignaturesForDevice(
  db: D1Database,
  userId: string,
  deviceId: string,
  deviceKey: DeviceKeysPayload,
): Promise<DeviceKeysPayload> {
  const dbSignatures = await listCrossSigningSignaturesForKey(db, userId, deviceId);

  if (dbSignatures.length === 0) {
    return deviceKey;
  }

  const mergedSignatures: Record<string, StringMap> = deviceKey.signatures
    ? { ...deviceKey.signatures }
    : {};
  for (const sig of dbSignatures) {
    mergedSignatures[sig.signerUserId] = mergedSignatures[sig.signerUserId] ?? {};
    mergedSignatures[sig.signerUserId][sig.signerKeyId] = sig.signature;
  }
  deviceKey.signatures = mergedSignatures;
  return deviceKey;
}

export async function queryClientKeys(input: {
  env: Pick<AppEnv["Bindings"], "SERVER_NAME" | "DB" | "CACHE" | "USER_KEYS">;
  requesterUserId: string;
  request: KeysQueryRequest;
}): Promise<{
  deviceKeys: UserDeviceKeysMap;
  masterKeys: UserCrossSigningKeyMap;
  selfSigningKeys: UserCrossSigningKeyMap;
  userSigningKeys: UserCrossSigningKeyMap;
  failures: JsonObjectMap;
}> {
  const { env, requesterUserId } = input;
  const requestedKeys = input.request.device_keys;
  const logger = createKeysLogger("query", { user_id: requesterUserId });

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

  if (requestedKeys) {
    const localServerName = env.SERVER_NAME;
    const remoteRequestsByServer: Record<string, DeviceKeyRequestMap> = {};

    for (const [userId, devices] of Object.entries(requestedKeys)) {
      const typedUserId = toUserId(userId);
      if (!typedUserId) {
        continue;
      }
      deviceKeys[typedUserId] = {};
      const userServerName = extractServerNameFromMatrixId(typedUserId);
      if (userServerName && userServerName !== localServerName) {
        remoteRequestsByServer[userServerName] = remoteRequestsByServer[userServerName] ?? {};
        remoteRequestsByServer[userServerName][typedUserId] = devices;
        continue;
      }

      const requestedDevices = Array.isArray(devices) && devices.length > 0 ? devices : null;
      if (requestedDevices === null || requestedDevices.length === 0) {
        const allDeviceKeys = await fetchAllDeviceKeysFromDO(env, typedUserId);
        for (const [deviceId, keys] of Object.entries(allDeviceKeys)) {
          if (keys) {
            deviceKeys[typedUserId][deviceId] = await mergeSignaturesForDevice(
              env.DB,
              typedUserId,
              deviceId,
              keys,
            );
          }
        }
      } else {
        for (const deviceId of requestedDevices) {
          const keys = await fetchDeviceKeyFromDO(env, typedUserId, deviceId);
          if (keys) {
            deviceKeys[typedUserId][deviceId] = await mergeSignaturesForDevice(
              env.DB,
              typedUserId,
              deviceId,
              keys,
            );
          }
        }
      }

      const csKeys = await fetchCrossSigningKeysFromDO(env, typedUserId);
      if (csKeys.master) {
        masterKeys[typedUserId] = csKeys.master;
      }
      if (csKeys.self_signing) {
        selfSigningKeys[typedUserId] = csKeys.self_signing;
      }
      if (csKeys.user_signing && typedUserId === requesterUserId) {
        userSigningKeys[typedUserId] = csKeys.user_signing;
      }
    }

    for (const [serverName, remoteRequests] of Object.entries(remoteRequestsByServer)) {
      const { response, failure } = await queryRemoteDeviceKeys(
        env,
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

  return {
    deviceKeys,
    masterKeys,
    selfSigningKeys,
    userSigningKeys,
    failures,
  };
}

export async function queryClientKeyChanges(input: {
  db: D1Database;
  userId: string;
  from: string;
  to: string;
}): Promise<{ changed: Set<string>; left: Set<string> }> {
  const { db, userId, from, to } = input;
  const typedUserId = toUserId(userId);
  if (!typedUserId) {
    return { changed: new Set<string>(), left: new Set<string>() };
  }
  const fromToken = parseSyncToken(from);
  const toToken = parseSyncToken(to);
  const fromEventPosition = fromToken.events;
  const toEventPosition = toToken.events;
  const fromDeviceKeyPosition = fromToken.deviceKeys;
  const toDeviceKeyPosition = toToken.deviceKeys;

  const [localChanged, remoteChanged, newlyShared, currentMembersInJoinedRooms, noLongerShared] =
    await Promise.all([
      listVisibleLocalDeviceKeyChanges(db, typedUserId, fromDeviceKeyPosition, toDeviceKeyPosition),
      listVisibleRemoteDeviceKeyChanges(
        db,
        typedUserId,
        fromDeviceKeyPosition,
        toDeviceKeyPosition,
      ),
      listNewlySharedUsers(db, typedUserId, fromEventPosition, toEventPosition),
      listCurrentMembersInJoinedRooms(db, typedUserId, fromEventPosition, toEventPosition),
      listNoLongerSharedUsers(db, typedUserId, fromEventPosition, toEventPosition),
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

  return { changed, left };
}
