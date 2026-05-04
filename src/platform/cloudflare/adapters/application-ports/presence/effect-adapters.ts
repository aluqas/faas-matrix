import { Effect } from "effect";
import type { Env } from "../../../env";
import type { AppContext } from "../../../../../fatrix-backend/ports/runtime/app-context";
import type { PresenceRecord } from "../../repositories/presence-repository";
import {
  findPresenceByUserId,
  touchLastActive as dbTouchLastActive,
  upsertPresence,
  writePresenceToCache,
} from "../../repositories/presence-repository";
import { userExists } from "../../repositories/user-auth-repository";
import {
  fromInfraNullable,
  fromInfraPromise,
  fromInfraVoid,
} from "../../../../../fatrix-backend/application/effect/infra-effect";
import { getSharedServersInRoomsWithUserIncludingPartialState } from "../../../../../fatrix-backend/application/features/partial-state/shared-servers";
import { queueFederationEdu } from "../shared/federation-edu-queue";
import type { PresenceCommandEffectPorts } from "../../../../../fatrix-backend/application/features/presence/command";
import type {
  PresenceQueryPorts,
  PresenceStatusResult,
} from "../../../../../fatrix-backend/application/features/presence/query";
import { InfraError } from "../../../../../fatrix-backend/application/domain-error";

function toPresenceStatusResult(record: PresenceRecord): PresenceStatusResult {
  return {
    presence: record.presence,
    ...(record.statusMsg !== undefined ? { statusMsg: record.statusMsg } : {}),
    lastActiveAgo: record.lastActiveAgo,
    currentlyActive: record.currentlyActive,
  };
}

export function createPresenceCommandPorts(
  env: Pick<Env, "DB" | "CACHE" | "SERVER_NAME"> & Env,
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
  env: Pick<Env, "DB" | "CACHE">,
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
  env: Pick<Env, "DB">,
  userId: import("../../../../../fatrix-model/types").UserId,
): Effect.Effect<void, InfraError> {
  return fromInfraVoid(() => dbTouchLastActive(env.DB, userId), "Failed to update last active");
}
