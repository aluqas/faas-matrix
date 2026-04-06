import { Effect } from "effect";
import type { AppEnv, JsonObject, ProfileResponseBody, UserId } from "../../../../types";
import { InfraError } from "../../domain-error";
import {
  getLocalProfileRecord,
  updateLocalProfile,
} from "../../../repositories/profile-repository";
import type { ProfileCommandPorts } from "./command";
import type { ProfileQueryPorts } from "./query";
import { queryProfileResponse } from "./profile-query";
import { parseStoredProfileCustomData } from "./shared";

const PROFILE_CACHE_TTL_SECONDS = 365 * 24 * 60 * 60;

function toInfraError(message: string, cause: unknown, status = 500): InfraError {
  return new InfraError({
    errcode: "M_UNKNOWN",
    message,
    status,
    cause,
  });
}

function getStoredProfileCustomDataEffect(
  cache: KVNamespace,
  userId: UserId,
): Effect.Effect<JsonObject, InfraError> {
  return Effect.tryPromise({
    try: async () => parseStoredProfileCustomData(await cache.get(`profile:${userId}:custom`)),
    catch: (cause) => toInfraError("Failed to load custom profile data", cause),
  });
}

export function createProfileQueryPorts(
  env: Pick<AppEnv["Bindings"], "SERVER_NAME" | "DB" | "CACHE">,
): ProfileQueryPorts {
  return {
    localServerName: env.SERVER_NAME,
    getProfile: (userId, field) =>
      Effect.tryPromise({
        try: () =>
          queryProfileResponse({
            userId,
            ...(field !== undefined ? { field } : {}),
            localServerName: env.SERVER_NAME,
            db: env.DB,
            cache: env.CACHE,
          }) as Promise<ProfileResponseBody | null>,
        catch: (cause) => toInfraError("Failed to query profile", cause),
      }),
    getLocalUserExists: (userId) =>
      Effect.tryPromise({
        try: async () => (await getLocalProfileRecord(env.DB, userId)) !== null,
        catch: (cause) => toInfraError("Failed to load local user", cause),
      }),
    getStoredCustomProfile: (userId) => getStoredProfileCustomDataEffect(env.CACHE, userId),
  };
}

export function createProfileCommandPorts(
  env: Pick<AppEnv["Bindings"], "SERVER_NAME" | "DB" | "CACHE">,
): ProfileCommandPorts {
  return {
    localServerName: env.SERVER_NAME,
    updateProfile: (userId, update) =>
      Effect.tryPromise({
        try: () => updateLocalProfile(env.DB, userId, update),
        catch: (cause) => toInfraError("Failed to update profile", cause),
      }),
    getStoredCustomProfile: (userId) => getStoredProfileCustomDataEffect(env.CACHE, userId),
    putStoredCustomProfile: (userId, value) =>
      Effect.tryPromise({
        try: () =>
          env.CACHE.put(`profile:${userId}:custom`, JSON.stringify(value), {
            expirationTtl: PROFILE_CACHE_TTL_SECONDS,
          }),
        catch: (cause) => toInfraError("Failed to store custom profile data", cause),
      }),
  };
}
