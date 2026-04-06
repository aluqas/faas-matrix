import { Effect } from "effect";
import type { JsonObject } from "../../../../types/common";
import type {
  DeleteCustomProfileKeyInput,
  ProfileField,
  PutCustomProfileKeyInput,
  UpdateProfileFieldInput,
} from "../../../../types/profile";
import type { UserId } from "../../../../types/matrix";
import { Errors, MatrixApiError } from "../../../../utils/errors";
import { InfraError } from "../../domain-error";
import { isLocalProfileUser, isStandardProfileField } from "./shared";

type ProfileFieldUpdate = Partial<Record<ProfileField, string | null>>;

export interface ProfileCommandPorts {
  localServerName: string;
  updateProfile(userId: UserId, update: ProfileFieldUpdate): Effect.Effect<void, InfraError>;
  getStoredCustomProfile(userId: UserId): Effect.Effect<JsonObject, InfraError>;
  putStoredCustomProfile(userId: UserId, value: JsonObject): Effect.Effect<void, InfraError>;
}

function ensureOwnProfile(
  authUserId: UserId,
  targetUserId: UserId,
): Effect.Effect<void, MatrixApiError> {
  return authUserId === targetUserId
    ? Effect.void
    : Effect.fail(Errors.forbidden("Cannot modify another user's profile"));
}

function ensureLocalProfileTarget(
  userId: UserId,
  localServerName: string,
): Effect.Effect<void, MatrixApiError> {
  return isLocalProfileUser(userId, localServerName)
    ? Effect.void
    : Effect.fail(Errors.notFound("User not found"));
}

export function updateProfileFieldEffect(
  ports: ProfileCommandPorts,
  input: UpdateProfileFieldInput,
): Effect.Effect<void, MatrixApiError | InfraError> {
  return Effect.gen(function* () {
    yield* ensureOwnProfile(input.authUserId, input.targetUserId);
    yield* ensureLocalProfileTarget(input.targetUserId, ports.localServerName);
    yield* ports.updateProfile(input.targetUserId, { [input.field]: input.value });
  });
}

export function putCustomProfileKeyEffect(
  ports: ProfileCommandPorts,
  input: PutCustomProfileKeyInput,
): Effect.Effect<void, MatrixApiError | InfraError> {
  return Effect.gen(function* () {
    yield* ensureOwnProfile(input.authUserId, input.targetUserId);
    yield* ensureLocalProfileTarget(input.targetUserId, ports.localServerName);
    if (isStandardProfileField(input.keyName)) {
      return yield* Effect.fail(Errors.unrecognized("Use specific endpoint"));
    }

    const profileData = yield* ports.getStoredCustomProfile(input.targetUserId);
    yield* ports.putStoredCustomProfile(input.targetUserId, {
      ...profileData,
      [input.keyName]: input.value,
    });
  });
}

export function deleteCustomProfileKeyEffect(
  ports: ProfileCommandPorts,
  input: DeleteCustomProfileKeyInput,
): Effect.Effect<void, MatrixApiError | InfraError> {
  return Effect.gen(function* () {
    yield* ensureOwnProfile(input.authUserId, input.targetUserId);
    yield* ensureLocalProfileTarget(input.targetUserId, ports.localServerName);
    if (isStandardProfileField(input.keyName)) {
      return yield* Effect.fail(Errors.forbidden("Cannot delete standard profile keys"));
    }

    const profileData = yield* ports.getStoredCustomProfile(input.targetUserId);
    const nextProfileData = { ...profileData };
    delete nextProfileData[input.keyName];
    yield* ports.putStoredCustomProfile(input.targetUserId, nextProfileData);
  });
}
