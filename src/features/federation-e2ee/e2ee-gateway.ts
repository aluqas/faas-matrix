import type { AppEnv } from "../../shared/types";
import {
  parseE2EECrossSigningKeysStore,
  parseE2EEDeviceKeysMap,
  parseE2EEDeviceKeysPayload,
  parseStoredOneTimeKeyBuckets,
} from "../../shared/types";
import type {
  CrossSigningKeysStore,
  DeviceKeysPayload,
  StoredOneTimeKeyBuckets,
} from "../../shared/types/client";
import { fetchDurableObjectJson, postDurableObjectVoid } from "../shared/do-gateway";
import { getKvJsonValue, putKvJsonValue } from "../shared/kv-gateway";

export async function fetchAllDeviceKeysFromDO(
  env: Pick<AppEnv["Bindings"], "USER_KEYS">,
  userId: string,
): Promise<Record<string, DeviceKeysPayload>> {
  const parsed = parseE2EEDeviceKeysMap(
    await fetchDurableObjectJson(
      env,
      "USER_KEYS",
      userId,
      "http://internal/device-keys/get",
      "DO device-keys get",
    ),
  );
  if (!parsed) {
    throw new Error("DO device-keys get returned invalid payload");
  }

  return parsed;
}

export async function fetchDeviceKeyFromDO(
  env: Pick<AppEnv["Bindings"], "USER_KEYS">,
  userId: string,
  deviceId: string,
): Promise<DeviceKeysPayload | null> {
  const payload = await fetchDurableObjectJson(
    env,
    "USER_KEYS",
    userId,
    `http://internal/device-keys/get?device_id=${encodeURIComponent(deviceId)}`,
    "DO device-keys get",
  );
  if (payload === null) {
    return null;
  }

  const parsed = parseE2EEDeviceKeysPayload(payload);
  if (!parsed) {
    throw new Error("DO device-keys get returned invalid payload");
  }

  return parsed;
}

export async function fetchCrossSigningKeysFromDO(
  env: Pick<AppEnv["Bindings"], "USER_KEYS">,
  userId: string,
): Promise<CrossSigningKeysStore> {
  const parsed = parseE2EECrossSigningKeysStore(
    await fetchDurableObjectJson(
      env,
      "USER_KEYS",
      userId,
      "http://internal/cross-signing/get",
      "DO cross-signing get",
    ),
  );
  if (!parsed) {
    throw new Error("DO cross-signing get returned invalid payload");
  }

  return parsed;
}

export async function storeDeviceKeysToDO(
  env: Pick<AppEnv["Bindings"], "USER_KEYS">,
  userId: string,
  deviceId: string,
  keys: DeviceKeysPayload,
): Promise<void> {
  await postDurableObjectVoid(
    env,
    "USER_KEYS",
    userId,
    "http://internal/device-keys/put",
    { device_id: deviceId, keys },
    "DO device-keys put",
  );
}

export async function storeCrossSigningKeysToDO(
  env: Pick<AppEnv["Bindings"], "USER_KEYS">,
  userId: string,
  keys: CrossSigningKeysStore,
): Promise<void> {
  await postDurableObjectVoid(
    env,
    "USER_KEYS",
    userId,
    "http://internal/cross-signing/put",
    keys,
    "DO cross-signing put",
  );
}

export async function loadStoredOneTimeKeyBuckets(
  env: Pick<AppEnv["Bindings"], "ONE_TIME_KEYS">,
  userId: string,
  deviceId: string,
): Promise<StoredOneTimeKeyBuckets | null> {
  const stored = await getKvJsonValue(env, "ONE_TIME_KEYS", `otk:${userId}:${deviceId}`);
  if (stored === null) {
    return null;
  }

  const parsed = parseStoredOneTimeKeyBuckets(stored);
  if (!parsed) {
    throw new Error("KV one-time-keys get returned invalid payload");
  }

  return parsed;
}

export function saveStoredOneTimeKeyBuckets(
  env: Pick<AppEnv["Bindings"], "ONE_TIME_KEYS">,
  userId: string,
  deviceId: string,
  buckets: StoredOneTimeKeyBuckets,
): Promise<void> {
  return putKvJsonValue(env, "ONE_TIME_KEYS", `otk:${userId}:${deviceId}`, buckets);
}

export function cacheDeviceKeys(
  env: Pick<AppEnv["Bindings"], "DEVICE_KEYS">,
  userId: string,
  deviceId: string,
  keys: DeviceKeysPayload,
): Promise<void> {
  return putKvJsonValue(env, "DEVICE_KEYS", `device:${userId}:${deviceId}`, keys);
}

export function cacheCrossSigningKeys(
  env: Pick<AppEnv["Bindings"], "CROSS_SIGNING_KEYS">,
  userId: string,
  keys: CrossSigningKeysStore,
): Promise<void> {
  return putKvJsonValue(env, "CROSS_SIGNING_KEYS", `user:${userId}`, keys);
}
