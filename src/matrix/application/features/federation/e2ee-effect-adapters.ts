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
import { fromInfraPromise, fromInfraVoid } from "../../../lib/infra-effect";
import {
  fetchAllDeviceKeysFromDO,
  fetchCrossSigningKeysFromDO,
  fetchDeviceKeyFromDO,
  loadStoredOneTimeKeyBuckets,
  saveStoredOneTimeKeyBuckets,
} from "./e2ee-gateway";
import type { FederationE2EEQueryPorts } from "./e2ee-query";

function loadStoredOneTimeKeyBucketsEffect(
  env: Pick<AppEnv["Bindings"], "ONE_TIME_KEYS">,
  userId: UserId,
  deviceId: string,
) {
  return fromInfraPromise(
    () => loadStoredOneTimeKeyBuckets(env, userId, deviceId),
    "Failed to load one-time keys from KV",
  );
}

function saveStoredOneTimeKeyBucketsEffect(
  env: Pick<AppEnv["Bindings"], "ONE_TIME_KEYS">,
  userId: UserId,
  deviceId: string,
  buckets: StoredOneTimeKeyBuckets,
) {
  return fromInfraVoid(
    () => saveStoredOneTimeKeyBuckets(env, userId, deviceId, buckets),
    "Failed to store one-time keys in KV",
  );
}

export function createFederationE2EEQueryPorts(
  env: Pick<AppEnv["Bindings"], "SERVER_NAME" | "DB" | "ONE_TIME_KEYS" | "USER_KEYS">,
): FederationE2EEQueryPorts {
  return {
    localServerName: env.SERVER_NAME,
    identityRepository: {
      localUserExists: (userId) =>
        fromInfraPromise(() => localUserExists(env.DB, userId), "Failed to load user"),
      listStoredDevices: (userId) =>
        fromInfraPromise(() => listUserDevices(env.DB, userId), "Failed to load devices"),
      getDeviceKeyStreamId: (userId) =>
        fromInfraPromise(
          () => getDeviceKeyStreamId(env.DB, userId),
          "Failed to load device key stream id",
        ),
    },
    deviceKeysGateway: {
      getAllDeviceKeys: (userId) =>
        fromInfraPromise(() => fetchAllDeviceKeysFromDO(env, userId), "Failed to load device keys"),
      getDeviceKey: (userId, deviceId) =>
        fromInfraPromise(() => fetchDeviceKeyFromDO(env, userId, deviceId), "Failed to load device key"),
      getCrossSigningKeys: (userId) =>
        fromInfraPromise(() => fetchCrossSigningKeysFromDO(env, userId), "Failed to load cross-signing keys"),
    },
    signaturesRepository: {
      listDeviceSignatures: (userId, keyId) =>
        fromInfraPromise(
          () => listCrossSigningSignaturesForKey(env.DB, userId, keyId),
          "Failed to load device signatures",
        ),
    },
    oneTimeKeyStore: {
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
        fromInfraPromise(
          () => claimUnclaimedOneTimeKey(env.DB, userId, deviceId, algorithm, Date.now()),
          "Failed to claim one-time key",
        ),
      claimFallbackKey: (userId, deviceId, algorithm) =>
        fromInfraPromise(
          () => claimFallbackKey(env.DB, userId, deviceId, algorithm),
          "Failed to claim fallback key",
        ),
    },
  };
}
