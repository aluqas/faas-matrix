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
import { InfraError } from "../../domain-error";
import {
  attachCrossSigningKeys,
  claimKeyFromStores,
  loadRequestedDeviceKeys,
} from "./e2ee-query-helpers";

export interface FederationIdentityRepository {
  localUserExists(userId: UserId): Effect.Effect<boolean, InfraError>;
  listStoredDevices(userId: UserId): Effect.Effect<FederationStoredDeviceRecord[], InfraError>;
  getDeviceKeyStreamId(userId: UserId): Effect.Effect<number, InfraError>;
}

export interface FederationDeviceKeysGateway {
  getAllDeviceKeys(userId: UserId): Effect.Effect<Record<string, DeviceKeysPayload>, InfraError>;
  getDeviceKey(
    userId: UserId,
    deviceId: string,
  ): Effect.Effect<DeviceKeysPayload | null, InfraError>;
  getCrossSigningKeys(userId: UserId): Effect.Effect<CrossSigningKeysStore, InfraError>;
}

export interface FederationSignaturesRepository {
  listDeviceSignatures(
    userId: UserId,
    keyId: string,
  ): Effect.Effect<FederationDeviceSignatureRecord[], InfraError>;
}

export interface FederationOneTimeKeyStore {
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
}

export interface FederationE2EEQueryPorts {
  localServerName: string;
  identityRepository: FederationIdentityRepository;
  deviceKeysGateway: FederationDeviceKeysGateway;
  signaturesRepository: FederationSignaturesRepository;
  oneTimeKeyStore: FederationOneTimeKeyStore;
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

export function queryFederationDeviceKeysEffect(
  ports: FederationE2EEQueryPorts,
  input: FederationKeysQueryInput,
): Effect.Effect<FederationKeysQueryResponseBody, InfraError> {
  return Effect.gen(function* () {
    let response: FederationKeysQueryResponseBody = {
      device_keys: {},
    };

    for (const [rawUserId, requestedDevices] of Object.entries(input.requestedKeys)) {
      const userId = toLocalUserId(rawUserId, ports.localServerName);
      if (!userId) {
        continue;
      }

      const userExists = yield* ports.identityRepository.localUserExists(userId);
      if (!userExists) {
        continue;
      }

      response = {
        ...response,
        device_keys: {
          ...response.device_keys,
          [userId]: yield* loadRequestedDeviceKeys(ports, userId, requestedDevices),
        },
      };

      const crossSigningKeys = yield* ports.deviceKeysGateway.getCrossSigningKeys(userId);
      response = attachCrossSigningKeys(response, userId, crossSigningKeys);
    }

    return response;
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
        const claimedKey = yield* claimKeyFromStores(ports, userId, deviceId, algorithm);
        if (claimedKey) {
          oneTimeKeys[userId][deviceId] = claimedKey;
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

    const userExists = yield* ports.identityRepository.localUserExists(input.userId);
    if (!userExists) {
      return yield* Effect.fail(Errors.notFound("User not found"));
    }

    const [devices, allDeviceKeys, streamId, crossSigningKeys] = yield* Effect.all([
      ports.identityRepository.listStoredDevices(input.userId),
      ports.deviceKeysGateway.getAllDeviceKeys(input.userId),
      ports.identityRepository.getDeviceKeyStreamId(input.userId),
      ports.deviceKeysGateway.getCrossSigningKeys(input.userId),
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
