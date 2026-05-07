import type { Env } from "../../../env";
import { isUserJoinedToRoom } from "../../repositories/membership-repository";
import { fromInfraPromise } from "../../../../../fatrix-backend/application/effect/infra-effect";
import type { AccountDataCommandPorts } from "../../../../../fatrix-backend/application/features/account-data/command";
import { notifyAccountDataChangeEffect } from "./notify";
import {
  deleteGlobalAccountDataEffect,
  deleteRoomAccountDataEffect,
  persistGlobalAccountDataEffect,
  persistRoomAccountDataEffect,
} from "./persistence";
import type { AccountDataQueryPorts } from "../../../../../fatrix-backend/application/features/account-data/query";
import { loadDatabaseAccountDataEffect, loadGlobalAccountDataEffect } from "./storage";

export function createAccountDataQueryPorts(
  env: Pick<Env, "DB" | "ACCOUNT_DATA" | "USER_KEYS">,
): AccountDataQueryPorts {
  return {
    accountDataReader: {
      getGlobalAccountData: (userId, eventType) =>
        loadGlobalAccountDataEffect(env, userId, eventType),
      getRoomAccountData: (userId, roomId, eventType) =>
        loadDatabaseAccountDataEffect(env, userId, roomId, eventType),
    },
    membership: {
      isUserJoinedToRoom: (userId, roomId) =>
        fromInfraPromise(
          () => isUserJoinedToRoom(env.DB, roomId, userId),
          "Failed to verify room membership",
        ),
    },
  };
}

export function createAccountDataCommandPorts(
  env: Pick<Env, "DB" | "ACCOUNT_DATA" | "USER_KEYS" | "SYNC">,
): AccountDataCommandPorts {
  return {
    accountDataWriter: {
      putGlobalAccountData: (userId, eventType, content) =>
        persistGlobalAccountDataEffect(env, userId, eventType, content),
      deleteGlobalAccountData: (userId, eventType) =>
        deleteGlobalAccountDataEffect(env, userId, eventType),
      putRoomAccountData: (userId, roomId, eventType, content) =>
        persistRoomAccountDataEffect(env, userId, roomId, eventType, content),
      deleteRoomAccountData: (userId, roomId, eventType) =>
        deleteRoomAccountDataEffect(env, userId, roomId, eventType),
    },
    membership: {
      isUserJoinedToRoom: (userId, roomId) =>
        fromInfraPromise(
          () => isUserJoinedToRoom(env.DB, roomId, userId),
          "Failed to verify room membership",
        ),
    },
    accountDataNotifier: {
      notifyAccountDataChange: ({ userId, roomId, eventType }) =>
        notifyAccountDataChangeEffect(env, { userId, roomId, eventType }),
    },
  };
}
