import { Effect } from "effect";
import type { DeviceRecord } from "../../infra/repositories/devices-repository";
import type { UserId } from "../../shared/types";
import { Errors, MatrixApiError } from "../../shared/utils/errors";
import { InfraError } from "../../matrix/application/domain-error";

export interface DeviceQueryPorts {
  deviceRepository: {
    listDevices(userId: UserId): Effect.Effect<DeviceRecord[], InfraError>;
    getDevice(userId: UserId, deviceId: string): Effect.Effect<DeviceRecord | null, InfraError>;
  };
}

export function listDevicesEffect(
  ports: DeviceQueryPorts,
  input: { authUserId: UserId },
): Effect.Effect<DeviceRecord[], MatrixApiError | InfraError> {
  return ports.deviceRepository.listDevices(input.authUserId);
}

export function getDeviceEffect(
  ports: DeviceQueryPorts,
  input: { authUserId: UserId; deviceId: string },
): Effect.Effect<DeviceRecord, MatrixApiError | InfraError> {
  return Effect.gen(function* () {
    const device = yield* ports.deviceRepository.getDevice(input.authUserId, input.deviceId);
    return yield* device
      ? Effect.succeed(device)
      : Effect.fail(Errors.notFound("Device not found"));
  });
}
