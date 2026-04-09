import { Effect } from "effect";
import type { AppEnv, FederationClaimedOneTimeKeyRecord, UserId } from "../../../../types";
import type { StoredOneTimeKeyBuckets } from "../../../../types/client";
import {
  claimFallbackKey,
  claimUnclaimedOneTimeKey,
  getDeviceKeyStreamId,
  listCrossSigningSignaturesForKey,
  listUserDevices,
  localUserExists,
} from "../../../repositories/federation-e2ee-repository";
import { InfraError } from "../../domain-error";
import {
  fetchAllDeviceKeysFromDO,
  fetchCrossSigningKeysFromDO,
  fetchDeviceKeyFromDO,
  loadStoredOneTimeKeyBuckets,
  saveStoredOneTimeKeyBuckets,
} from "./e2ee-gateway";
import type { FederationE2EEQueryPorts } from "./e2ee-query";

function toInfraError(message: string, cause: unknown, status = 500): InfraError {
  return new InfraError({
    errcode: "M_UNKNOWN",
    message,
    status,
    cause,
  });
}

function loadStoredOneTimeKeyBucketsEffect(
  env: Pick<AppEnv["Bindings"], "ONE_TIME_KEYS">,
  userId: UserId,
  deviceId: string,
): Effect.Effect<StoredOneTimeKeyBuckets | null, InfraError> {
  return Effect.tryPromise({
    try: () => loadStoredOneTimeKeyBuckets(env, userId, deviceId),
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
    try: () => saveStoredOneTimeKeyBuckets(env, userId, deviceId, buckets),
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

        const keyIndex = bucket.findIndex((key: StoredOneTimeKeyBuckets[string][number]) => !key.claimed);
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
        try: () => claimUnclaimedOneTimeKey(env.DB, userId, deviceId, algorithm, Date.now()),
        catch: (cause) => toInfraError("Failed to claim one-time key", cause),
      }),
    claimFallbackKey: (userId, deviceId, algorithm) =>
      Effect.tryPromise({
        try: () => claimFallbackKey(env.DB, userId, deviceId, algorithm),
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
