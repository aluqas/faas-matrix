import type { AppEnv } from "../../shared/types";
import type { KeysUploadRequest } from "../../shared/types/client";
import { runClientEffect } from "../../matrix/application/runtime/effect-runtime";
import { publishDeviceListUpdateToSharedServers } from "../device-lists/command";
import { getSharedServersInRoomsWithUserIncludingPartialState } from "../partial-state/shared-servers";
import { queueFederationEdu } from "../shared/federation-edu-queue";
import { createKeysLogger } from "./shared";
import {
  cacheDeviceKeys,
  loadStoredOneTimeKeyBuckets,
  saveStoredOneTimeKeyBuckets,
  storeDeviceKeysToDO,
} from "../e2ee-shared/gateway";
import {
  recordDeviceKeyChangeWithKysely,
  upsertFallbackKeyBackups,
  upsertOneTimeKeyBackups,
} from "../../infra/repositories/e2ee-repository";

export async function uploadClientKeys(input: {
  env: Pick<
    AppEnv["Bindings"],
    | "DB"
    | "CACHE"
    | "SERVER_NAME"
    | "USER_KEYS"
    | "DEVICE_KEYS"
    | "ONE_TIME_KEYS"
    | "CROSS_SIGNING_KEYS"
  >;
  userId: string;
  deviceId: string;
  request: KeysUploadRequest;
}): Promise<{ oneTimeKeyCounts: Record<string, number> }> {
  const { env, userId, deviceId } = input;
  const { device_keys, one_time_keys, fallback_keys } = input.request;
  const logger = createKeysLogger("upload", { user_id: userId, device_id: deviceId });

  await runClientEffect(
    logger.info("keys.command.start", {
      command: "upload",
      has_device_keys: Boolean(device_keys),
      one_time_key_count: one_time_keys ? Object.keys(one_time_keys).length : 0,
      fallback_key_count: fallback_keys ? Object.keys(fallback_keys).length : 0,
    }),
  );

  if (device_keys) {
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
      throw new Error(
        `device_keys.user_id and device_keys.device_id must match authenticated user. Got user_id=${device_keys.user_id} (expected ${userId}), device_id=${device_keys.device_id} (expected ${deviceId})`,
      );
    }

    await storeDeviceKeysToDO(env, userId, deviceId, device_keys);
    await cacheDeviceKeys(env, userId, deviceId, device_keys);
    await recordDeviceKeyChangeWithKysely(env.DB, userId, deviceId, "update");

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
          localServerName: env.SERVER_NAME,
          now: () => Date.now(),
          getSharedRemoteServers: (sharedUserId) =>
            getSharedServersInRoomsWithUserIncludingPartialState(env.DB, env.CACHE, sharedUserId),
          queueEdu: (destination, eduType, content) =>
            queueFederationEdu(env as AppEnv["Bindings"], destination, eduType, content),
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

  const oneTimeKeyCounts: Record<string, number> = {};

  if (one_time_keys) {
    const existingKeys = (await loadStoredOneTimeKeyBuckets(env, userId, deviceId)) ?? {};

    for (const [keyId, keyData] of Object.entries(one_time_keys)) {
      const [algorithm] = keyId.split(":");
      if (!algorithm) {
        continue;
      }

      const bucket = existingKeys[algorithm] ?? [];
      existingKeys[algorithm] ??= bucket;

      const existingIndex = bucket.findIndex((storedKey) => storedKey.keyId === keyId);
      if (existingIndex >= 0) {
        bucket[existingIndex] = { keyId, keyData, claimed: false };
      } else {
        bucket.push({ keyId, keyData, claimed: false });
      }
    }

    await upsertOneTimeKeyBackups(env.DB, userId, deviceId, one_time_keys);
    await saveStoredOneTimeKeyBuckets(env, userId, deviceId, existingKeys);

    for (const [algorithm, keys] of Object.entries(existingKeys)) {
      oneTimeKeyCounts[algorithm] = keys.filter((k) => !k.claimed).length;
    }
  } else {
    const parsedExistingKeys = await loadStoredOneTimeKeyBuckets(env, userId, deviceId);
    if (parsedExistingKeys) {
      for (const [algorithm, keys] of Object.entries(parsedExistingKeys)) {
        oneTimeKeyCounts[algorithm] = keys.filter((k) => !k.claimed).length;
      }
    }
  }

  if (fallback_keys) {
    await upsertFallbackKeyBackups(env.DB, userId, deviceId, fallback_keys);
  }

  await runClientEffect(
    logger.info("keys.command.success", {
      command: "upload",
      one_time_algorithms: Object.keys(oneTimeKeyCounts).length,
    }),
  );

  return { oneTimeKeyCounts };
}
