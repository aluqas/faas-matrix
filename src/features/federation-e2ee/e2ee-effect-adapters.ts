import type { AppEnv } from "../../shared/types";
import {
  claimFallbackKey,
  claimUnclaimedOneTimeKey,
  getDeviceKeyStreamId,
  listCrossSigningSignaturesForKey,
  listUserDevices,
  localUserExists,
} from "../../infra/repositories/federation-e2ee-repository";
import { fromInfraPromise } from "../../shared/effect/infra-effect";
import {
  fetchAllDeviceKeysFromDO,
  fetchCrossSigningKeysFromDO,
  fetchDeviceKeyFromDO,
} from "./e2ee-gateway";
import { claimStoredOneTimeKeyWithMirrorMark } from "./e2ee-claim-store";
import type { FederationE2EEQueryPorts } from "./e2ee-query";

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
        fromInfraPromise(
          () => claimStoredOneTimeKeyWithMirrorMark(env, userId, deviceId, algorithm, Date.now()),
          "Failed to claim stored one-time key",
        ),
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
