import { Effect } from "effect";
import type { AppEnv } from "../../shared/types";
import type { AppContext } from "../../shared/runtime/app-context";
import type { PresenceRecord } from "../../infra/repositories/presence-repository";
import {
  findPresenceByUserId,
  touchLastActive as dbTouchLastActive,
  upsertPresence,
  writePresenceToCache,
} from "../../infra/repositories/presence-repository";
import { userExists } from "../../infra/repositories/user-auth-repository";
import {
  fromInfraNullable,
  fromInfraPromise,
  fromInfraVoid,
} from "../../shared/effect/infra-effect";
import { getSharedServersInRoomsWithUserIncludingPartialState } from "../partial-state/shared-servers";
import { queueFederationEdu } from "../shared/federation-edu-queue";
import type { PresenceCommandEffectPorts } from "./command";
import type { PresenceQueryPorts, PresenceStatusResult } from "./query";
import { InfraError } from "../../matrix/application/domain-error";

function toPresenceStatusResult(record: PresenceRecord): PresenceStatusResult {
  return {
    presence: record.presence,
    ...(record.statusMsg !== undefined ? { statusMsg: record.statusMsg } : {}),
    lastActiveAgo: record.lastActiveAgo,
    currentlyActive: record.currentlyActive,
  };
}

export function createPresenceCommandPorts(
  env: Pick<AppEnv["Bindings"], "DB" | "CACHE" | "SERVER_NAME"> & AppEnv["Bindings"],
  debugEnabled: boolean,
): PresenceCommandEffectPorts {
  return {
    localServerName: env.SERVER_NAME,
    debugEnabled,
    presenceStore: {
      persistPresence: (input) =>
        fromInfraVoid(async () => {
          await upsertPresence(
            env.DB,
            input.userId,
            input.presence,
            input.statusMessage ?? null,
            input.now,
          );

          if (env.CACHE) {
            await writePresenceToCache(
              env.CACHE,
              input.userId,
              input.presence,
              input.statusMessage ?? null,
              input.now,
            );
          }
        }, "Failed to persist presence"),
    },
    interestedServers: {
      listInterestedServers: (userId) =>
        fromInfraPromise(
          () => getSharedServersInRoomsWithUserIncludingPartialState(env.DB, env.CACHE, userId),
          "Failed to resolve presence destinations",
        ),
    },
    federation: {
      queuePresenceEdu: (destination, content) =>
        fromInfraVoid(
          () =>
            queueFederationEdu(
              env,
              destination,
              "m.presence",
              content as unknown as Record<string, unknown>,
            ),
          "Failed to queue presence EDU",
        ),
    },
  };
}

export function createPresenceCommandPortsFromAppContext(
  appContext: AppContext,
): PresenceCommandEffectPorts {
  const db = appContext.capabilities.sql.connection as D1Database;
  const cache = appContext.capabilities.kv.cache as KVNamespace | undefined;
  return {
    localServerName: appContext.capabilities.config.serverName,
    debugEnabled: appContext.profile.name === "complement",
    presenceStore: {
      persistPresence: (input) =>
        fromInfraVoid(async () => {
          await upsertPresence(
            db,
            input.userId,
            input.presence,
            input.statusMessage ?? null,
            input.now,
          );

          if (cache) {
            await writePresenceToCache(
              cache,
              input.userId,
              input.presence,
              input.statusMessage ?? null,
              input.now,
            );
          }
        }, "Failed to persist presence"),
    },
    interestedServers: {
      listInterestedServers: (userId) =>
        fromInfraPromise(
          () => getSharedServersInRoomsWithUserIncludingPartialState(db, cache, userId),
          "Failed to resolve presence destinations",
        ),
    },
    federation: {
      queuePresenceEdu: (destination, content) =>
        fromInfraVoid(async () => {
          await appContext.capabilities.federation?.queueEdu?.(
            destination,
            "m.presence",
            content as unknown as Record<string, unknown>,
          );
        }, "Failed to queue presence EDU"),
    },
  };
}

export function createPresenceQueryPorts(
  env: Pick<AppEnv["Bindings"], "DB" | "CACHE">,
): PresenceQueryPorts {
  return {
    userDirectory: {
      userExists: (userId) =>
        fromInfraPromise(() => userExists(env.DB, userId), "Failed to load user"),
    },
    presenceStore: {
      getPresence: (userId) =>
        fromInfraNullable(async () => {
          const record = await findPresenceByUserId(env.DB, userId, env.CACHE);
          return record ? toPresenceStatusResult(record) : null;
        }, "Failed to load presence"),
    },
  };
}

export function touchLastActiveEffect(
  env: Pick<AppEnv["Bindings"], "DB">,
  userId: import("../../shared/types").UserId,
): Effect.Effect<void, InfraError> {
  return fromInfraVoid(() => dbTouchLastActive(env.DB, userId), "Failed to update last active");
}
