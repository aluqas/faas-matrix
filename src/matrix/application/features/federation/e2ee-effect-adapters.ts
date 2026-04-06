import { Effect } from "effect";
import type { AppEnv, FederationClaimedOneTimeKeyRecord, UserId } from "../../../../types";
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
import {
  findFallbackKey,
  findUnclaimedOneTimeKey,
  getDeviceKeyStreamId,
  listCrossSigningSignaturesForKey,
  listUserDevices,
  localUserExists,
  markFallbackKeyUsed,
  markOneTimeKeyClaimed,
} from "../../../repositories/federation-e2ee-repository";
import { InfraError } from "../../domain-error";
import type { FederationE2EEQueryPorts } from "./e2ee-query";

function toInfraError(message: string, cause: unknown, status = 500): InfraError {
  return new InfraError({
    errcode: "M_UNKNOWN",
    message,
    status,
    cause,
  });
}

function getUserKeysDO(
  env: Pick<AppEnv["Bindings"], "USER_KEYS">,
  userId: string,
): DurableObjectStub {
  const id = env.USER_KEYS.idFromName(userId);
  return env.USER_KEYS.get(id);
}

async function fetchAllDeviceKeysFromDO(
  env: Pick<AppEnv["Bindings"], "USER_KEYS">,
  userId: UserId,
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

async function fetchDeviceKeyFromDO(
  env: Pick<AppEnv["Bindings"], "USER_KEYS">,
  userId: UserId,
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

async function fetchCrossSigningKeysFromDO(
  env: Pick<AppEnv["Bindings"], "USER_KEYS">,
  userId: UserId,
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

function loadStoredOneTimeKeyBucketsEffect(
  env: Pick<AppEnv["Bindings"], "ONE_TIME_KEYS">,
  userId: UserId,
  deviceId: string,
): Effect.Effect<StoredOneTimeKeyBuckets | null, InfraError> {
  return Effect.tryPromise({
    try: async () => {
      const stored = await env.ONE_TIME_KEYS.get(`otk:${userId}:${deviceId}`, "json");
      return stored === null ? null : parseStoredOneTimeKeyBuckets(stored);
    },
    catch: (cause) => toInfraError("Failed to load one-time keys from KV", cause),
  });
}

function saveStoredOneTimeKeyBucketsEffect(
  env: Pick<AppEnv["Bindings"], "ONE_TIME_KEYS">,
  userId: UserId,
  deviceId: string,
  buckets: StoredOneTimeKeyBuckets,
): Effect.Effect<void, InfraError> {
  return Effect.tryPromise({
    try: () => env.ONE_TIME_KEYS.put(`otk:${userId}:${deviceId}`, JSON.stringify(buckets)),
    catch: (cause) => toInfraError("Failed to store one-time keys in KV", cause),
  });
}

export function createFederationE2EEQueryPorts(
  env: Pick<AppEnv["Bindings"], "SERVER_NAME" | "DB" | "ONE_TIME_KEYS" | "USER_KEYS">,
): FederationE2EEQueryPorts {
  return {
    localServerName: env.SERVER_NAME,
    localUserExists: (userId) =>
      Effect.tryPromise({
        try: () => localUserExists(env.DB, userId),
        catch: (cause) => toInfraError("Failed to load user", cause),
      }),
    getAllDeviceKeys: (userId) =>
      Effect.tryPromise({
        try: () => fetchAllDeviceKeysFromDO(env, userId),
        catch: (cause) => toInfraError("Failed to load device keys", cause),
      }),
    getDeviceKey: (userId, deviceId) =>
      Effect.tryPromise({
        try: () => fetchDeviceKeyFromDO(env, userId, deviceId),
        catch: (cause) => toInfraError("Failed to load device key", cause),
      }),
    getCrossSigningKeys: (userId) =>
      Effect.tryPromise({
        try: () => fetchCrossSigningKeysFromDO(env, userId),
        catch: (cause) => toInfraError("Failed to load cross-signing keys", cause),
      }),
    listDeviceSignatures: (userId, keyId) =>
      Effect.tryPromise({
        try: () => listCrossSigningSignaturesForKey(env.DB, userId, keyId),
        catch: (cause) => toInfraError("Failed to load device signatures", cause),
      }),
    claimStoredOneTimeKey: (userId, deviceId, algorithm) =>
      Effect.gen(function* () {
        const existingKeys = yield* loadStoredOneTimeKeyBucketsEffect(env, userId, deviceId);
        const bucket = existingKeys?.[algorithm];
        if (!bucket) {
          return null;
        }

        const keyIndex = bucket.findIndex((key) => !key.claimed);
        if (keyIndex < 0) {
          return null;
        }

        const key = bucket[keyIndex];
        bucket[keyIndex] = { ...key, claimed: true };
        yield* saveStoredOneTimeKeyBucketsEffect(env, userId, deviceId, existingKeys);
        return {
          keyId: key.keyId,
          keyData: key.keyData,
        } satisfies FederationClaimedOneTimeKeyRecord;
      }),
    claimDatabaseOneTimeKey: (userId, deviceId, algorithm) =>
      Effect.tryPromise({
        try: async () => {
          const key = await findUnclaimedOneTimeKey(env.DB, userId, deviceId, algorithm);
          if (!key) {
            return null;
          }
          await markOneTimeKeyClaimed(env.DB, key.id, Date.now());
          return {
            keyId: key.keyId,
            keyData: key.keyData,
          } satisfies FederationClaimedOneTimeKeyRecord;
        },
        catch: (cause) => toInfraError("Failed to claim one-time key", cause),
      }),
    claimFallbackKey: (userId, deviceId, algorithm) =>
      Effect.tryPromise({
        try: async () => {
          const key = await findFallbackKey(env.DB, userId, deviceId, algorithm);
          if (!key) {
            return null;
          }
          await markFallbackKeyUsed(env.DB, userId, deviceId, algorithm);
          return key;
        },
        catch: (cause) => toInfraError("Failed to claim fallback key", cause),
      }),
    listStoredDevices: (userId) =>
      Effect.tryPromise({
        try: () => listUserDevices(env.DB, userId),
        catch: (cause) => toInfraError("Failed to load devices", cause),
      }),
    getDeviceKeyStreamId: (userId) =>
      Effect.tryPromise({
        try: () => getDeviceKeyStreamId(env.DB, userId),
        catch: (cause) => toInfraError("Failed to load device key stream id", cause),
      }),
  };
}
