import type { AppEnv, UserId } from "../../shared/types";
import {
  getLocalProfileRecord,
  updateLocalProfile,
} from "../../infra/repositories/profile-repository";
import { fromInfraNullable, fromInfraPromise, fromInfraVoid } from "../../shared/effect/infra-effect";
import {
  getKvTextValue,
  putKvJsonValue,
} from "../shared/kv-gateway";
import type { ProfileCommandPorts } from "./command";
import { fetchRemoteProfileResponse } from "./profile-federation-gateway";
import type { ProfileQueryPorts } from "./query";
import { parseStoredProfileCustomData } from "./shared";

const PROFILE_CACHE_TTL_SECONDS = 365 * 24 * 60 * 60;

function getStoredProfileCustomDataEffect(cache: KVNamespace, userId: UserId) {
  return fromInfraPromise(
    async () =>
      parseStoredProfileCustomData(
        await getKvTextValue({ CACHE: cache }, "CACHE", `profile:${userId}:custom`),
      ),
    "Failed to load custom profile data",
  );
}

export function createProfileQueryPorts(
  env: Pick<AppEnv["Bindings"], "SERVER_NAME" | "DB" | "CACHE">,
): ProfileQueryPorts {
  return {
    localServerName: env.SERVER_NAME,
    profileRepository: {
      getLocalProfile: (userId) =>
        fromInfraNullable(() => getLocalProfileRecord(env.DB, userId), "Failed to query profile"),
      getLocalUserExists: (userId) =>
        fromInfraPromise(
          async () => (await getLocalProfileRecord(env.DB, userId)) !== null,
          "Failed to load local user",
        ),
    },
    customProfileStore: {
      getStoredCustomProfile: (userId) => getStoredProfileCustomDataEffect(env.CACHE, userId),
    },
    profileGateway: {
      fetchRemoteProfile: (serverName, userId, field) =>
        fromInfraNullable(
          () => fetchRemoteProfileResponse(env, serverName, userId, field),
          "Failed to query profile",
        ),
    },
  };
}

export function createProfileCommandPorts(
  env: Pick<AppEnv["Bindings"], "SERVER_NAME" | "DB" | "CACHE">,
): ProfileCommandPorts {
  return {
    localServerName: env.SERVER_NAME,
    profileRepository: {
      updateProfile: (userId, update) =>
        fromInfraVoid(() => updateLocalProfile(env.DB, userId, update), "Failed to update profile"),
    },
    customProfileStore: {
      getStoredCustomProfile: (userId) => getStoredProfileCustomDataEffect(env.CACHE, userId),
      putStoredCustomProfile: (userId, value) =>
        fromInfraVoid(
          () =>
            putKvJsonValue({ CACHE: env.CACHE }, "CACHE", `profile:${userId}:custom`, value, {
              expirationTtl: PROFILE_CACHE_TTL_SECONDS,
            }),
          "Failed to store custom profile data",
        ),
    },
  };
}
