import { Effect } from "effect";
import type { AppEnv } from "../../shared/types";
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
import { executePresenceCommand } from "./command";
import type { PresenceCommandInput, PresenceCommandPorts } from "./contracts";
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

export interface PresenceCommandEffectPorts {
  executor: {
    execute(input: PresenceCommandInput): Effect.Effect<void, InfraError>;
  };
}

function createAsyncPresenceCommandPorts(
  env: Pick<AppEnv["Bindings"], "DB" | "CACHE" | "SERVER_NAME"> & AppEnv["Bindings"],
  debugEnabled: boolean,
): PresenceCommandPorts {
  return {
    localServerName: env.SERVER_NAME,
    async persistPresence(input) {
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
    },
    resolveInterestedServers: (userId) =>
      getSharedServersInRoomsWithUserIncludingPartialState(env.DB, env.CACHE, userId),
    queueEdu: (destination, content) => queueFederationEdu(env, destination, "m.presence", content),
    debugEnabled,
  };
}

export function createPresenceCommandPorts(
  env: Pick<AppEnv["Bindings"], "DB" | "CACHE" | "SERVER_NAME"> & AppEnv["Bindings"],
  debugEnabled: boolean,
): PresenceCommandEffectPorts {
  return {
    executor: {
      execute: (input) =>
        fromInfraPromise(
          () => executePresenceCommand(input, createAsyncPresenceCommandPorts(env, debugEnabled)),
          "Failed to update presence",
        ),
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
