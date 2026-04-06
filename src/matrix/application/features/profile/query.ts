import { Effect } from "effect";
import type { JsonObject } from "../../../../types/common";
import type {
  GetCustomProfileKeyInput,
  ProfileCustomKeyResponseBody,
  ProfileField,
  ProfileQueryInput,
  ProfileResponseBody,
} from "../../../../types/profile";
import type { UserId } from "../../../../types/matrix";
import { Errors, MatrixApiError } from "../../../../utils/errors";
import { InfraError } from "../../domain-error";
import { isLocalProfileUser } from "./shared";

export interface ProfileQueryPorts {
  localServerName: string;
  getProfile(
    userId: UserId,
    field?: ProfileField,
  ): Effect.Effect<ProfileResponseBody | null, InfraError>;
  getLocalUserExists(userId: UserId): Effect.Effect<boolean, InfraError>;
  getStoredCustomProfile(userId: UserId): Effect.Effect<JsonObject, InfraError>;
}

export function queryProfileEffect(
  ports: ProfileQueryPorts,
  input: ProfileQueryInput,
): Effect.Effect<ProfileResponseBody, MatrixApiError | InfraError> {
  return Effect.flatMap(ports.getProfile(input.userId, input.field), (profile) =>
    profile ? Effect.succeed(profile) : Effect.fail(Errors.notFound("User not found")),
  );
}

export function queryCustomProfileKeyEffect(
  ports: ProfileQueryPorts,
  input: GetCustomProfileKeyInput,
): Effect.Effect<ProfileCustomKeyResponseBody, MatrixApiError | InfraError> {
  return Effect.gen(function* () {
    if (!isLocalProfileUser(input.targetUserId, ports.localServerName)) {
      return yield* Effect.fail(Errors.notFound("User not found"));
    }

    const userExists = yield* ports.getLocalUserExists(input.targetUserId);
    if (!userExists) {
      return yield* Effect.fail(Errors.notFound("User not found"));
    }

    const profileData = yield* ports.getStoredCustomProfile(input.targetUserId);
    const value = profileData[input.keyName];
    if (value === undefined) {
      return yield* Effect.fail(Errors.notFound(`Profile key '${input.keyName}' not found`));
    }

    return { [input.keyName]: value };
  });
}
