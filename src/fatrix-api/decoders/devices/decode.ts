import { Effect } from "effect";
import type { UserId } from "../../../fatrix-model/types";
import { Errors, MatrixApiError } from "../../../fatrix-model/utils/errors";
import { parseUserIdLike } from "../../../fatrix-model/utils/ids";
import type { PasswordAuthInput } from "../../../fatrix-backend/application/features/devices/command";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodeAuthUserId(value: string): UserId | MatrixApiError {
  return parseUserIdLike(value) ?? Errors.unknownToken();
}

function decodeAuth(value: unknown): PasswordAuthInput | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const identifier = isRecord(value.identifier)
    ? {
        ...(typeof value.identifier.type === "string" ? { type: value.identifier.type } : {}),
        ...(typeof value.identifier.user === "string" ? { user: value.identifier.user } : {}),
      }
    : undefined;

  return {
    ...(typeof value.type === "string" ? { type: value.type } : {}),
    ...(typeof value.password === "string" ? { password: value.password } : {}),
    ...(typeof value.session === "string" ? { session: value.session } : {}),
    ...(identifier ? { identifier } : {}),
  };
}

export function decodeGetDeviceInput(input: {
  authUserId: string;
  deviceId: string;
}): Effect.Effect<{ authUserId: UserId; deviceId: string }, MatrixApiError> {
  return Effect.gen(function* () {
    const authUserId = decodeAuthUserId(input.authUserId);
    if (authUserId instanceof MatrixApiError) {
      return yield* Effect.fail(authUserId);
    }

    return { authUserId, deviceId: input.deviceId };
  });
}

export function decodeUpdateDeviceInput(input: {
  authUserId: string;
  deviceId: string;
  body: unknown;
}): Effect.Effect<
  { authUserId: UserId; deviceId: string; displayName: string | null },
  MatrixApiError
> {
  return Effect.gen(function* () {
    const authUserId = decodeAuthUserId(input.authUserId);
    if (authUserId instanceof MatrixApiError) {
      return yield* Effect.fail(authUserId);
    }
    if (!isRecord(input.body)) {
      return yield* Effect.fail(Errors.badJson());
    }

    const displayName =
      input.body.display_name === undefined
        ? null
        : typeof input.body.display_name === "string"
          ? input.body.display_name
          : null;

    return {
      authUserId,
      deviceId: input.deviceId,
      displayName,
    };
  });
}

export function decodeDeleteDeviceInput(input: {
  authUserId: string;
  deviceId: string;
  body?: unknown;
}): Effect.Effect<
  { authUserId: UserId; deviceId: string; auth?: PasswordAuthInput },
  MatrixApiError
> {
  return Effect.gen(function* () {
    const authUserId = decodeAuthUserId(input.authUserId);
    if (authUserId instanceof MatrixApiError) {
      return yield* Effect.fail(authUserId);
    }

    return {
      authUserId,
      deviceId: input.deviceId,
      ...(isRecord(input.body) && "auth" in input.body
        ? { auth: decodeAuth(input.body.auth) }
        : {}),
    };
  });
}

export function decodeDeleteDevicesInput(input: {
  authUserId: string;
  body: unknown;
}): Effect.Effect<
  { authUserId: UserId; deviceIds: string[]; auth?: PasswordAuthInput },
  MatrixApiError
> {
  return Effect.gen(function* () {
    const authUserId = decodeAuthUserId(input.authUserId);
    if (authUserId instanceof MatrixApiError) {
      return yield* Effect.fail(authUserId);
    }
    if (!isRecord(input.body) || !Array.isArray(input.body.devices)) {
      return yield* Effect.fail(Errors.missingParam("devices"));
    }

    return {
      authUserId,
      deviceIds: input.body.devices.filter((value): value is string => typeof value === "string"),
      ...(isRecord(input.body) && "auth" in input.body
        ? { auth: decodeAuth(input.body.auth) }
        : {}),
    };
  });
}
