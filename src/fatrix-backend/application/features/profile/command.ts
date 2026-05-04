import { Effect } from "effect";
import type { JsonObject } from "../../../../fatrix-model/types/common";
import type {
  DeleteCustomProfileKeyInput,
  ProfileField,
  PutCustomProfileKeyInput,
  UpdateProfileFieldInput,
} from "../../../../fatrix-model/types/profile";
import type { UserId } from "../../../../fatrix-model/types/matrix";
import { Errors, MatrixApiError } from "../../../../fatrix-model/utils/errors";
import { InfraError } from "../../domain-error";
import { requireLocalUser, requireOwnUser } from "../../effect/guards";
import { isStandardProfileField } from "./shared";

type ProfileFieldUpdate = Partial<Record<ProfileField, string | null>>;

export interface ProfileRepositoryService {
  updateProfile(userId: UserId, update: ProfileFieldUpdate): Effect.Effect<void, InfraError>;
}

export interface CustomProfileStoreService {
  getStoredCustomProfile(userId: UserId): Effect.Effect<JsonObject, InfraError>;
  putStoredCustomProfile(userId: UserId, value: JsonObject): Effect.Effect<void, InfraError>;
}

export interface ProfileCommandPorts {
  localServerName: string;
  profileRepository: ProfileRepositoryService;
  customProfileStore: CustomProfileStoreService;
}

export function updateProfileFieldEffect(
  ports: ProfileCommandPorts,
  input: UpdateProfileFieldInput,
): Effect.Effect<void, MatrixApiError | InfraError> {
  return Effect.gen(function* () {
    yield* requireOwnUser(
      input.authUserId,
      input.targetUserId,
      "Cannot modify another user's profile",
    );
    yield* requireLocalUser(input.targetUserId, ports.localServerName);
    yield* ports.profileRepository.updateProfile(input.targetUserId, {
      [input.field]: input.value,
    });
  });
}

export function putCustomProfileKeyEffect(
  ports: ProfileCommandPorts,
  input: PutCustomProfileKeyInput,
): Effect.Effect<void, MatrixApiError | InfraError> {
  return Effect.gen(function* () {
    yield* requireOwnUser(
      input.authUserId,
      input.targetUserId,
      "Cannot modify another user's profile",
    );
    yield* requireLocalUser(input.targetUserId, ports.localServerName);
    if (isStandardProfileField(input.keyName)) {
      return yield* Effect.fail(Errors.unrecognized("Use specific endpoint"));
    }

    const profileData = yield* ports.customProfileStore.getStoredCustomProfile(input.targetUserId);
    yield* ports.customProfileStore.putStoredCustomProfile(input.targetUserId, {
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
    yield* requireOwnUser(
      input.authUserId,
      input.targetUserId,
      "Cannot modify another user's profile",
    );
    yield* requireLocalUser(input.targetUserId, ports.localServerName);
    if (isStandardProfileField(input.keyName)) {
      return yield* Effect.fail(Errors.forbidden("Cannot delete standard profile keys"));
    }

    const profileData = yield* ports.customProfileStore.getStoredCustomProfile(input.targetUserId);
    const nextProfileData = { ...profileData };
    delete nextProfileData[input.keyName];
    yield* ports.customProfileStore.putStoredCustomProfile(input.targetUserId, nextProfileData);
  });
}
