import { Effect } from "effect";
import type { FederationKeysQueryResponseBody, UserId } from "../../../../fatrix-model/types";
import type {
  CrossSigningKeysStore,
  DeviceKeysPayload,
  DeviceOneTimeKeysMap,
  UserDeviceKeysMap,
} from "../../../../fatrix-model/types/client";
import type {
  FederationClaimedOneTimeKeyRecord,
  FederationDeviceSignatureRecord,
} from "../../../../fatrix-model/types/e2ee";
import type { JsonObject } from "../../../../fatrix-model/types/common";
import { InfraError } from "../../domain-error";
import type { FederationE2EEQueryPorts } from "./e2ee-query";

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

function markFallbackKey(keyData: JsonObject): JsonObject {
  return {
    ...keyData,
    fallback: true,
  };
}

function toClaimedOneTimeKeyEntry(
  key: FederationClaimedOneTimeKeyRecord,
  isFallback = false,
): DeviceOneTimeKeysMap[string] {
  return {
    [key.keyId]: isFallback ? markFallbackKey(key.keyData) : key.keyData,
  };
}

export function attachDeviceSignatures(
  ports: FederationE2EEQueryPorts,
  userId: UserId,
  deviceId: string,
  deviceKey: DeviceKeysPayload,
): Effect.Effect<DeviceKeysPayload, InfraError> {
  return Effect.map(
    ports.signaturesRepository.listDeviceSignatures(userId, deviceId),
    (signatures) => mergeDeviceSignatures(deviceKey, signatures),
  );
}

export function loadRequestedDeviceKeys(
  ports: FederationE2EEQueryPorts,
  userId: UserId,
  requestedDevices: string[] | undefined,
): Effect.Effect<UserDeviceKeysMap[UserId], InfraError> {
  return Effect.gen(function* () {
    const deviceKeys: UserDeviceKeysMap[UserId] = {};

    if (!requestedDevices || requestedDevices.length === 0) {
      const allDeviceKeys = yield* ports.deviceKeysGateway.getAllDeviceKeys(userId);
      for (const [deviceId, keys] of Object.entries(allDeviceKeys)) {
        deviceKeys[deviceId] = yield* attachDeviceSignatures(ports, userId, deviceId, keys);
      }
      return deviceKeys;
    }

    for (const deviceId of requestedDevices) {
      const keys = yield* ports.deviceKeysGateway.getDeviceKey(userId, deviceId);
      if (!keys) {
        continue;
      }
      deviceKeys[deviceId] = yield* attachDeviceSignatures(ports, userId, deviceId, keys);
    }

    return deviceKeys;
  });
}

export function attachCrossSigningKeys(
  response: FederationKeysQueryResponseBody,
  userId: UserId,
  deviceKeys: CrossSigningKeysStore,
): FederationKeysQueryResponseBody {
  const next: FederationKeysQueryResponseBody = {
    ...response,
    device_keys: {
      ...response.device_keys,
    },
  };

  if (deviceKeys.master) {
    next.master_keys = {
      ...next.master_keys,
      [userId]: deviceKeys.master,
    };
  }

  if (deviceKeys.self_signing) {
    next.self_signing_keys = {
      ...next.self_signing_keys,
      [userId]: deviceKeys.self_signing,
    };
  }

  return next;
}

export function claimKeyFromStores(
  ports: FederationE2EEQueryPorts,
  userId: UserId,
  deviceId: string,
  algorithm: string,
): Effect.Effect<DeviceOneTimeKeysMap[string] | null, InfraError> {
  return Effect.gen(function* () {
    const storedKey = yield* ports.oneTimeKeyStore.claimStoredOneTimeKey(
      userId,
      deviceId,
      algorithm,
    );
    if (storedKey) {
      return toClaimedOneTimeKeyEntry(storedKey);
    }

    const dbKey = yield* ports.oneTimeKeyStore.claimDatabaseOneTimeKey(userId, deviceId, algorithm);
    if (dbKey) {
      return toClaimedOneTimeKeyEntry(dbKey);
    }

    const fallbackKey = yield* ports.oneTimeKeyStore.claimFallbackKey(userId, deviceId, algorithm);
    return fallbackKey ? toClaimedOneTimeKeyEntry(fallbackKey, true) : null;
  });
}
