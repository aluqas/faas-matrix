import type { Env } from "../../../env";
import {
  fromInfraNullable,
  fromInfraPromise,
  fromInfraVoid,
} from "../../../../../fatrix-backend/application/effect/infra-effect";
import {
  deleteAccessTokensForDevice,
  deleteDeviceForUser,
  deleteDevicesForUser,
  findDeviceForUser,
  listDevicesForUser,
  updateDeviceDisplayName,
} from "../../repositories/devices-repository";
import { getUserPasswordHash } from "../../repositories/user-auth-repository";
import { recordDeviceKeyChange } from "../../realtime/device-key-changes";
import { queueFederationEdu } from "../shared/federation-edu-queue";
import { getSharedServersInRoomsWithUserIncludingPartialState } from "../../../../../fatrix-backend/application/features/partial-state/shared-servers";
import { getStoredDeviceKeys, putStoredDeviceKeys } from "./device-keys-gateway";
import type { DeviceCommandPorts } from "../../../../../fatrix-backend/application/features/devices/command";
import type { DeviceQueryPorts } from "../../../../../fatrix-backend/application/features/devices/query";

export function createDeviceQueryPorts(env: Pick<Env, "DB">): DeviceQueryPorts {
  return {
    deviceRepository: {
      listDevices: (userId) =>
        fromInfraPromise(() => listDevicesForUser(env.DB, userId), "Failed to list devices"),
      getDevice: (userId, deviceId) =>
        fromInfraNullable(
          () => findDeviceForUser(env.DB, userId, deviceId),
          "Failed to load device",
        ),
    },
  };
}

export function createDeviceCommandPorts(
  env: Pick<Env, "DB" | "USER_KEYS" | "DEVICE_KEYS" | "SERVER_NAME" | "CACHE"> &
    Env,
): DeviceCommandPorts {
  return {
    localServerName: env.SERVER_NAME,
    deviceRepository: {
      getDevice: (userId, deviceId) =>
        fromInfraNullable(
          () => findDeviceForUser(env.DB, userId, deviceId),
          "Failed to load device",
        ),
      updateDeviceDisplayName: (userId, deviceId, displayName) =>
        fromInfraVoid(
          () => updateDeviceDisplayName(env.DB, userId, deviceId, displayName),
          "Failed to update device",
        ),
      deleteDeviceAccessTokens: (userId, deviceId) =>
        fromInfraVoid(
          () => deleteAccessTokensForDevice(env.DB, userId, deviceId),
          "Failed to delete device tokens",
        ),
      deleteDevice: (userId, deviceId) =>
        fromInfraVoid(
          () => deleteDeviceForUser(env.DB, userId, deviceId),
          "Failed to delete device",
        ),
      deleteDevices: (userId, deviceIds) =>
        fromInfraVoid(
          () => deleteDevicesForUser(env.DB, userId, deviceIds),
          "Failed to delete devices",
        ),
    },
    userAuth: {
      getPasswordHash: (userId) =>
        fromInfraNullable(
          () => getUserPasswordHash(env.DB, userId),
          "Failed to load password hash",
        ),
    },
    deviceKeysGateway: {
      getStoredDeviceKeys: (userId, deviceId) =>
        fromInfraNullable(
          () => getStoredDeviceKeys(env, userId, deviceId),
          "Failed to load stored device keys",
        ),
      putStoredDeviceKeys: (userId, deviceId, keys) =>
        fromInfraVoid(
          () => putStoredDeviceKeys(env, userId, deviceId, keys),
          "Failed to store device keys",
        ),
    },
    deviceKeyChanges: {
      recordChange: (userId, deviceId, changeType) =>
        fromInfraVoid(
          () => recordDeviceKeyChange(env.DB, userId, deviceId, changeType),
          "Failed to record device key change",
        ),
    },
    sharedServers: {
      getSharedRemoteServers: (userId) =>
        getSharedServersInRoomsWithUserIncludingPartialState(env.DB, env.CACHE, userId),
      queueEdu: (destination, eduType, content) =>
        queueFederationEdu(env, destination, eduType, content),
    },
  };
}
