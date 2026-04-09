import type { DeviceKeysPayload } from "../../shared/types/client";
import { parseDeviceKeysPayload } from "../../api/keys-contracts";

function getUserKeysDO(env: Pick<import("../../shared/types").Env, "USER_KEYS">, userId: string): DurableObjectStub {
  const id = env.USER_KEYS.idFromName(userId);
  return env.USER_KEYS.get(id);
}

export async function getStoredDeviceKeys(
  env: Pick<import("../../shared/types").Env, "USER_KEYS">,
  userId: string,
  deviceId: string,
): Promise<DeviceKeysPayload | null> {
  const stub = getUserKeysDO(env, userId);
  const response = await stub.fetch(
    new Request(`http://internal/device-keys/get?device_id=${encodeURIComponent(deviceId)}`),
  );
  if (!response.ok) {
    return null;
  }

  return parseDeviceKeysPayload(await response.json().catch(() => null));
}

export async function putStoredDeviceKeys(
  env: Pick<import("../../shared/types").Env, "USER_KEYS" | "DEVICE_KEYS">,
  userId: string,
  deviceId: string,
  keys: DeviceKeysPayload,
): Promise<void> {
  const stub = getUserKeysDO(env, userId);
  const response = await stub.fetch(
    new Request("http://internal/device-keys/put", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: deviceId, keys }),
    }),
  );
  if (!response.ok) {
    const errorText = await response.text().catch(() => "unknown error");
    throw new Error(`Failed to store device keys in DO: ${response.status} ${errorText}`);
  }

  await env.DEVICE_KEYS.put(`device:${userId}:${deviceId}`, JSON.stringify(keys));
}
