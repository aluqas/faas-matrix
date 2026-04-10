import { Effect } from "effect";
import { verifyPassword } from "../../shared/utils/crypto";
import type { DeviceKeysPayload } from "../../shared/types/client";
import type { UserId } from "../../shared/types";
import { Errors, MatrixApiError } from "../../shared/utils/errors";
import { InfraError } from "../../matrix/application/domain-error";
import { publishDeviceListUpdateToSharedServers } from "../device-lists/command";

export interface PasswordAuthInput {
  type?: string;
  password?: string;
  session?: string;
  identifier?: { type?: string; user?: string };
}

export interface DeviceCommandPorts {
  localServerName: string;
  deviceRepository: {
    getDevice(
      userId: UserId,
      deviceId: string,
    ): Effect.Effect<
      {
        deviceId: string;
        displayName: string | null;
      } | null,
      InfraError
    >;
    updateDeviceDisplayName(
      userId: UserId,
      deviceId: string,
      displayName: string | null,
    ): Effect.Effect<void, InfraError>;
    deleteDeviceAccessTokens(userId: UserId, deviceId: string): Effect.Effect<void, InfraError>;
    deleteDevice(userId: UserId, deviceId: string): Effect.Effect<void, InfraError>;
    deleteDevices(userId: UserId, deviceIds: readonly string[]): Effect.Effect<void, InfraError>;
  };
  userAuth: {
    getPasswordHash(userId: UserId): Effect.Effect<string | null, InfraError>;
  };
  deviceKeysGateway: {
    getStoredDeviceKeys(
      userId: UserId,
      deviceId: string,
    ): Effect.Effect<DeviceKeysPayload | null, InfraError>;
    putStoredDeviceKeys(
      userId: UserId,
      deviceId: string,
      keys: DeviceKeysPayload,
    ): Effect.Effect<void, InfraError>;
  };
  deviceKeyChanges: {
    recordChange(
      userId: UserId,
      deviceId: string | null,
      changeType: string,
    ): Effect.Effect<void, InfraError>;
  };
  sharedServers: {
    getSharedRemoteServers(userId: UserId): Promise<string[]>;
    queueEdu(destination: string, eduType: string, content: Record<string, unknown>): Promise<void>;
  };
}

export type DeleteDeviceResult =
  | { kind: "success" }
  | { kind: "uia"; session: string; error?: string };

function withUpdatedDisplayName(
  keys: DeviceKeysPayload,
  displayName: string | null | undefined,
): DeviceKeysPayload {
  const nextUnsigned = { ...keys.unsigned };
  if (typeof displayName === "string" && displayName.length > 0) {
    nextUnsigned["device_display_name"] = displayName;
  } else {
    delete nextUnsigned["device_display_name"];
  }

  return {
    ...keys,
    unsigned: nextUnsigned,
  };
}

async function verifyPasswordAuth(
  authUserId: UserId,
  auth: PasswordAuthInput | undefined,
  passwordHash: string | null,
): Promise<{ ok: true } | { ok: false; session: string; error?: string }> {
  if (!auth) {
    return { ok: false, session: crypto.randomUUID() };
  }

  if (auth.type !== "m.login.password") {
    return {
      ok: false,
      session: auth.session ?? crypto.randomUUID(),
      error: "Invalid password",
    };
  }

  if (auth.identifier?.type === "m.id.user" && auth.identifier.user !== authUserId) {
    throw Errors.forbidden("Authenticated user does not own this device");
  }

  if (!passwordHash || !auth.password) {
    return {
      ok: false,
      session: auth.session ?? crypto.randomUUID(),
      error: "Invalid password",
    };
  }

  const valid = await verifyPassword(auth.password, passwordHash);
  return valid
    ? { ok: true }
    : {
        ok: false,
        session: auth.session ?? crypto.randomUUID(),
        error: "Invalid password",
      };
}

export function updateDeviceDisplayNameEffect(
  ports: DeviceCommandPorts,
  input: { authUserId: UserId; deviceId: string; displayName: string | null },
): Effect.Effect<void, MatrixApiError | InfraError> {
  return Effect.gen(function* () {
    const device = yield* ports.deviceRepository.getDevice(input.authUserId, input.deviceId);
    if (!device) {
      return yield* Effect.fail(Errors.notFound("Device not found"));
    }

    yield* ports.deviceRepository.updateDeviceDisplayName(
      input.authUserId,
      input.deviceId,
      input.displayName,
    );

    let deviceKeys: DeviceKeysPayload | null = null;
    try {
      const existingKeys = yield* ports.deviceKeysGateway.getStoredDeviceKeys(
        input.authUserId,
        input.deviceId,
      );
      if (existingKeys) {
        deviceKeys = withUpdatedDisplayName(existingKeys, input.displayName);
        yield* ports.deviceKeysGateway.putStoredDeviceKeys(
          input.authUserId,
          input.deviceId,
          deviceKeys,
        );
      }
    } catch {
      // Best-effort: device metadata update should not fail the endpoint.
    }

    yield* ports.deviceKeyChanges.recordChange(input.authUserId, input.deviceId, "update");

    try {
      yield* Effect.tryPromise({
        try: () =>
          publishDeviceListUpdateToSharedServers(
            {
              userId: input.authUserId,
              deviceId: input.deviceId,
              deviceDisplayName: input.displayName ?? undefined,
              keys: deviceKeys,
            },
            {
              localServerName: ports.localServerName,
              now: () => Date.now(),
              getSharedRemoteServers: () =>
                ports.sharedServers.getSharedRemoteServers(input.authUserId),
              queueEdu: (destination, eduType, content) =>
                ports.sharedServers.queueEdu(destination, eduType, content),
            },
          ),
        catch: (cause) =>
          new InfraError({
            errcode: "M_UNKNOWN",
            message: "Failed to publish device list update",
            status: 500,
            cause,
          }),
      });
    } catch {
      // Best-effort.
    }
  });
}

export function deleteDeviceEffect(
  ports: DeviceCommandPorts,
  input: { authUserId: UserId; deviceId: string; auth?: PasswordAuthInput },
): Effect.Effect<DeleteDeviceResult, MatrixApiError | InfraError> {
  return Effect.gen(function* () {
    const device = yield* ports.deviceRepository.getDevice(input.authUserId, input.deviceId);
    if (!device) {
      return yield* Effect.fail(Errors.notFound("Device not found"));
    }

    const passwordHash = yield* ports.userAuth.getPasswordHash(input.authUserId);
    const verified = yield* Effect.tryPromise({
      try: () => verifyPasswordAuth(input.authUserId, input.auth, passwordHash),
      catch: (cause) =>
        new InfraError({
          errcode: "M_UNKNOWN",
          message: "Failed to verify device deletion password",
          status: 500,
          cause,
        }),
    });
    if (!verified.ok) {
      return {
        kind: "uia",
        session: verified.session,
        ...(verified.error ? { error: verified.error } : {}),
      };
    }

    yield* ports.deviceRepository.deleteDeviceAccessTokens(input.authUserId, input.deviceId);
    yield* ports.deviceRepository.deleteDevice(input.authUserId, input.deviceId);
    return { kind: "success" };
  });
}

export function deleteDevicesEffect(
  ports: DeviceCommandPorts,
  input: { authUserId: UserId; deviceIds: readonly string[]; auth?: PasswordAuthInput },
): Effect.Effect<DeleteDeviceResult, MatrixApiError | InfraError> {
  return Effect.gen(function* () {
    const passwordHash = yield* ports.userAuth.getPasswordHash(input.authUserId);
    const verified = yield* Effect.tryPromise({
      try: () => verifyPasswordAuth(input.authUserId, input.auth, passwordHash),
      catch: (cause) =>
        new InfraError({
          errcode: "M_UNKNOWN",
          message: "Failed to verify bulk device deletion password",
          status: 500,
          cause,
        }),
    });
    if (!verified.ok) {
      return {
        kind: "uia",
        session: verified.session,
        ...(verified.error ? { error: verified.error } : {}),
      };
    }

    yield* ports.deviceRepository.deleteDevices(input.authUserId, input.deviceIds);
    return { kind: "success" };
  });
}
