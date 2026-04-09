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
import { requireLocalUser } from "../../../lib/guards";
import {
  dispatchLocalOrRemoteUserQueryEffect,
  resolveLocalOrRemoteUserTarget,
} from "../shared/local-remote-dispatch";

export interface ProfileRepositoryService {
  getLocalProfile(userId: UserId): Effect.Effect<ProfileResponseBody | null, InfraError>;
  getLocalUserExists(userId: UserId): Effect.Effect<boolean, InfraError>;
}

export interface CustomProfileStoreService {
  getStoredCustomProfile(userId: UserId): Effect.Effect<JsonObject, InfraError>;
}

export interface ProfileGatewayService {
  fetchRemoteProfile(
    serverName: string,
    userId: UserId,
    field?: ProfileField,
  ): Effect.Effect<ProfileResponseBody | null, InfraError>;
}

export interface ProfileQueryPorts {
  localServerName: string;
  profileRepository: ProfileRepositoryService;
  customProfileStore: CustomProfileStoreService;
  profileGateway: ProfileGatewayService;
}

export function queryProfileEffect(
  ports: ProfileQueryPorts,
  input: ProfileQueryInput,
): Effect.Effect<ProfileResponseBody, MatrixApiError | InfraError> {
  return Effect.gen(function* () {
    const target = resolveLocalOrRemoteUserTarget(input.userId, ports.localServerName);
    if (!target) {
      return yield* Effect.fail(Errors.notFound("User not found"));
    }

    const profile = yield* dispatchLocalOrRemoteUserQueryEffect(target, {
      field: input.field,
      loadLocal: (userId) => ports.profileRepository.getLocalProfile(userId),
      loadRemote: (serverName, userId, field) =>
        ports.profileGateway.fetchRemoteProfile(serverName, userId, field),
    });

    return yield* profile
      ? Effect.succeed(profile)
      : Effect.fail(Errors.notFound("User not found"));
  });
}

export function queryCustomProfileKeyEffect(
  ports: ProfileQueryPorts,
  input: GetCustomProfileKeyInput,
): Effect.Effect<ProfileCustomKeyResponseBody, MatrixApiError | InfraError> {
  return Effect.gen(function* () {
    yield* requireLocalUser(input.targetUserId, ports.localServerName);

    const userExists = yield* ports.profileRepository.getLocalUserExists(input.targetUserId);
    if (!userExists) {
      return yield* Effect.fail(Errors.notFound("User not found"));
    }

    const profileData = yield* ports.customProfileStore.getStoredCustomProfile(input.targetUserId);
    const value = profileData[input.keyName];
    if (value === undefined) {
      return yield* Effect.fail(Errors.notFound(`Profile key '${input.keyName}' not found`));
    }

    return { [input.keyName]: value };
  });
}
