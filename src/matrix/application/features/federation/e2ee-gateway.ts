import type { AppEnv } from "../../../../types";
import {
  parseE2EECrossSigningKeysStore,
  parseE2EEDeviceKeysMap,
  parseE2EEDeviceKeysPayload,
  parseStoredOneTimeKeyBuckets,
} from "../../../../types";
import type {
  CrossSigningKeysStore,
  DeviceKeysPayload,
  StoredOneTimeKeyBuckets,
} from "../../../../types/client";

function getUserKeysDO(
  env: Pick<AppEnv["Bindings"], "USER_KEYS">,
  userId: string,
): DurableObjectStub {
  const id = env.USER_KEYS.idFromName(userId);
  return env.USER_KEYS.get(id);
}

export async function fetchAllDeviceKeysFromDO(
  env: Pick<AppEnv["Bindings"], "USER_KEYS">,
  userId: string,
): Promise<Record<string, DeviceKeysPayload>> {
  const response = await getUserKeysDO(env, userId).fetch(
    new Request("http://internal/device-keys/get"),
  );
  if (!response.ok) {
    throw new Error(`DO device-keys get failed: ${response.status}`);
  }

  const parsed = parseE2EEDeviceKeysMap(await response.json().catch(() => null));
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
  const response = await getUserKeysDO(env, userId).fetch(
    new Request(`http://internal/device-keys/get?device_id=${encodeURIComponent(deviceId)}`),
  );
  if (!response.ok) {
    throw new Error(`DO device-keys get failed: ${response.status}`);
  }

  const payload = await response.json().catch(() => null);
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
  const response = await getUserKeysDO(env, userId).fetch(
    new Request("http://internal/cross-signing/get"),
  );
  if (!response.ok) {
    throw new Error(`DO cross-signing get failed: ${response.status}`);
  }

  const parsed = parseE2EECrossSigningKeysStore(await response.json().catch(() => null));
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
  const response = await getUserKeysDO(env, userId).fetch(
    new Request("http://internal/device-keys/put", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: deviceId, keys }),
    }),
  );
  if (!response.ok) {
    throw new Error(`DO device-keys put failed: ${response.status}`);
  }
}

export async function storeCrossSigningKeysToDO(
  env: Pick<AppEnv["Bindings"], "USER_KEYS">,
  userId: string,
  keys: CrossSigningKeysStore,
): Promise<void> {
  const response = await getUserKeysDO(env, userId).fetch(
    new Request("http://internal/cross-signing/put", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(keys),
    }),
  );
  if (!response.ok) {
    throw new Error(`DO cross-signing put failed: ${response.status}`);
  }
}

export async function loadStoredOneTimeKeyBuckets(
  env: Pick<AppEnv["Bindings"], "ONE_TIME_KEYS">,
  userId: string,
  deviceId: string,
): Promise<StoredOneTimeKeyBuckets | null> {
  const stored = await env.ONE_TIME_KEYS.get(`otk:${userId}:${deviceId}`, "json");
  return stored === null ? null : parseStoredOneTimeKeyBuckets(stored);
}

export function saveStoredOneTimeKeyBuckets(
  env: Pick<AppEnv["Bindings"], "ONE_TIME_KEYS">,
  userId: string,
  deviceId: string,
  buckets: StoredOneTimeKeyBuckets,
): Promise<void> {
  return env.ONE_TIME_KEYS.put(`otk:${userId}:${deviceId}`, JSON.stringify(buckets));
}

export function cacheDeviceKeys(
  env: Pick<AppEnv["Bindings"], "DEVICE_KEYS">,
  userId: string,
  deviceId: string,
  keys: DeviceKeysPayload,
): Promise<void> {
  return env.DEVICE_KEYS.put(`device:${userId}:${deviceId}`, JSON.stringify(keys));
}

export function cacheCrossSigningKeys(
  env: Pick<AppEnv["Bindings"], "CROSS_SIGNING_KEYS">,
  userId: string,
  keys: CrossSigningKeysStore,
): Promise<void> {
  return env.CROSS_SIGNING_KEYS.put(`user:${userId}`, JSON.stringify(keys));
}
