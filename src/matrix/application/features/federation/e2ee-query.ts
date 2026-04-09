import { Effect } from "effect";
import type {
  FederationClaimedOneTimeKeyRecord,
  FederationDeviceSignatureRecord,
  FederationKeysClaimInput,
  FederationKeysClaimResponseBody,
  FederationKeysQueryInput,
  FederationKeysQueryResponseBody,
  FederationStoredDeviceRecord,
  FederationUserDevicesInput,
  FederationUserDevicesResponseBody,
  UserId,
} from "../../../../types";
import { Errors, MatrixApiError } from "../../../../utils/errors";
import { toUserId } from "../../../../utils/ids";
import { extractServerNameFromMatrixId } from "../../../../utils/matrix-ids";
import type { CrossSigningKeysStore, DeviceKeysPayload } from "../../../../types/client";
import type { JsonObject } from "../../../../types/common";
import { InfraError } from "../../domain-error";

export interface FederationE2EEQueryPorts {
  localServerName: string;
  localUserExists(userId: UserId): Effect.Effect<boolean, InfraError>;
  getAllDeviceKeys(userId: UserId): Effect.Effect<Record<string, DeviceKeysPayload>, InfraError>;
  getDeviceKey(
    userId: UserId,
    deviceId: string,
  ): Effect.Effect<DeviceKeysPayload | null, InfraError>;
  getCrossSigningKeys(userId: UserId): Effect.Effect<CrossSigningKeysStore, InfraError>;
  listDeviceSignatures(
    userId: UserId,
    keyId: string,
  ): Effect.Effect<FederationDeviceSignatureRecord[], InfraError>;
  claimStoredOneTimeKey(
    userId: UserId,
    deviceId: string,
    algorithm: string,
  ): Effect.Effect<FederationClaimedOneTimeKeyRecord | null, InfraError>;
  claimDatabaseOneTimeKey(
    userId: UserId,
    deviceId: string,
    algorithm: string,
  ): Effect.Effect<FederationClaimedOneTimeKeyRecord | null, InfraError>;
  claimFallbackKey(
    userId: UserId,
    deviceId: string,
    algorithm: string,
  ): Effect.Effect<FederationClaimedOneTimeKeyRecord | null, InfraError>;
  listStoredDevices(userId: UserId): Effect.Effect<FederationStoredDeviceRecord[], InfraError>;
  getDeviceKeyStreamId(userId: UserId): Effect.Effect<number, InfraError>;
}

function toLocalUserId(rawUserId: string, localServerName: string): UserId | null {
  if (
    extractServerNameFromMatrixId(rawUserId) !== localServerName ||
    !rawUserId.startsWith("@") ||
    !rawUserId.includes(":")
  ) {
    return null;
  }
  return toUserId(rawUserId);
}

function mergeDeviceSignatures(
  deviceKey: DeviceKeysPayload,
  signatures: FederationDeviceSignatureRecord[],
): DeviceKeysPayload {
  if (signatures.length === 0) {
    return deviceKey;
  }

  const mergedSignatures: NonNullable<DeviceKeysPayload["signatures"]> = {
    ...deviceKey.signatures,
  };

  for (const signature of signatures) {
    mergedSignatures[signature.signerUserId] = {
      ...mergedSignatures[signature.signerUserId],
      [signature.signerKeyId]: signature.signature,
    };
  }

  return {
    ...deviceKey,
    signatures: mergedSignatures,
  };
}

function withFallbackMarker(keyData: JsonObject): JsonObject {
  return {
    ...keyData,
    fallback: true,
  };
}

export function queryFederationDeviceKeysEffect(
  ports: FederationE2EEQueryPorts,
  input: FederationKeysQueryInput,
): Effect.Effect<FederationKeysQueryResponseBody, InfraError> {
  return Effect.gen(function* () {
    const deviceKeys: FederationKeysQueryResponseBody["device_keys"] = {};
    const masterKeys: NonNullable<FederationKeysQueryResponseBody["master_keys"]> = {};
    const selfSigningKeys: NonNullable<FederationKeysQueryResponseBody["self_signing_keys"]> = {};

    for (const [rawUserId, requestedDevices] of Object.entries(input.requestedKeys)) {
      const userId = toLocalUserId(rawUserId, ports.localServerName);
      if (!userId) {
        continue;
      }

      const userExists = yield* ports.localUserExists(userId);
      if (!userExists) {
        continue;
      }

      deviceKeys[userId] = {};

      if (!requestedDevices || requestedDevices.length === 0) {
        const allDeviceKeys = yield* ports.getAllDeviceKeys(userId);
        for (const [deviceId, keys] of Object.entries(allDeviceKeys)) {
          const signatures = yield* ports.listDeviceSignatures(userId, deviceId);
          deviceKeys[userId][deviceId] = mergeDeviceSignatures(keys, signatures);
        }
      } else {
        for (const deviceId of requestedDevices) {
          const keys = yield* ports.getDeviceKey(userId, deviceId);
          if (!keys) {
            continue;
          }
          const signatures = yield* ports.listDeviceSignatures(userId, deviceId);
          deviceKeys[userId][deviceId] = mergeDeviceSignatures(keys, signatures);
        }
      }

      const crossSigningKeys = yield* ports.getCrossSigningKeys(userId);
      if (crossSigningKeys.master) {
        masterKeys[userId] = crossSigningKeys.master;
      }
      if (crossSigningKeys.self_signing) {
        selfSigningKeys[userId] = crossSigningKeys.self_signing;
      }
    }

    return {
      device_keys: deviceKeys,
      ...(Object.keys(masterKeys).length > 0 ? { master_keys: masterKeys } : {}),
      ...(Object.keys(selfSigningKeys).length > 0 ? { self_signing_keys: selfSigningKeys } : {}),
    };
  });
}

export function claimFederationOneTimeKeysEffect(
  ports: FederationE2EEQueryPorts,
  input: FederationKeysClaimInput,
): Effect.Effect<FederationKeysClaimResponseBody, InfraError> {
  return Effect.gen(function* () {
    const oneTimeKeys: FederationKeysClaimResponseBody["one_time_keys"] = {};

    for (const [rawUserId, devices] of Object.entries(input.requestedKeys)) {
      const userId = toLocalUserId(rawUserId, ports.localServerName);
      if (!userId) {
        continue;
      }

      oneTimeKeys[userId] = {};

      for (const [deviceId, algorithm] of Object.entries(devices)) {
        const storedKey = yield* ports.claimStoredOneTimeKey(userId, deviceId, algorithm);
        if (storedKey) {
          oneTimeKeys[userId][deviceId] = {
            [storedKey.keyId]: storedKey.keyData,
          };
          continue;
        }

        const dbKey = yield* ports.claimDatabaseOneTimeKey(userId, deviceId, algorithm);
        if (dbKey) {
          oneTimeKeys[userId][deviceId] = {
            [dbKey.keyId]: dbKey.keyData,
          };
          continue;
        }

        const fallbackKey = yield* ports.claimFallbackKey(userId, deviceId, algorithm);
        if (fallbackKey) {
          oneTimeKeys[userId][deviceId] = {
            [fallbackKey.keyId]: withFallbackMarker(fallbackKey.keyData),
          };
        }
      }
    }

    return {
      one_time_keys: oneTimeKeys,
    };
  });
}

export function queryFederationUserDevicesEffect(
  ports: FederationE2EEQueryPorts,
  input: FederationUserDevicesInput,
): Effect.Effect<FederationUserDevicesResponseBody, MatrixApiError | InfraError> {
  return Effect.gen(function* () {
    if (extractServerNameFromMatrixId(input.userId) !== ports.localServerName) {
      return yield* Effect.fail(Errors.forbidden("User is not local to this server"));
    }

    const userExists = yield* ports.localUserExists(input.userId);
    if (!userExists) {
      return yield* Effect.fail(Errors.notFound("User not found"));
    }

    const [devices, allDeviceKeys, streamId, crossSigningKeys] = yield* Effect.all([
      ports.listStoredDevices(input.userId),
      ports.getAllDeviceKeys(input.userId),
      ports.getDeviceKeyStreamId(input.userId),
      ports.getCrossSigningKeys(input.userId),
    ]);

    return {
      user_id: input.userId,
      stream_id: streamId,
      devices: devices.map((device) => ({
        device_id: device.deviceId,
        ...(allDeviceKeys[device.deviceId] ? { keys: allDeviceKeys[device.deviceId] } : {}),
        ...(device.displayName ? { device_display_name: device.displayName } : {}),
      })),
      ...(crossSigningKeys.master ? { master_key: crossSigningKeys.master } : {}),
      ...(crossSigningKeys.self_signing ? { self_signing_key: crossSigningKeys.self_signing } : {}),
    };
  });
}
