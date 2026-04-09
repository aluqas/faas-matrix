import { Effect } from "effect";
import type { AppEnv } from "../../../../types";
import { isUserJoinedToRoom } from "../../../repositories/membership-repository";
import { InfraError } from "../../domain-error";
import type { AccountDataCommandPorts } from "./command";
import { notifyAccountDataChangeEffect } from "./notify";
import {
  deleteGlobalAccountDataEffect,
  deleteRoomAccountDataEffect,
  persistGlobalAccountDataEffect,
  persistRoomAccountDataEffect,
} from "./persistence";
import type { AccountDataQueryPorts } from "./query";
import {
  loadDatabaseAccountDataEffect,
  loadGlobalAccountDataEffect,
} from "./storage";

function toInfraError(message: string, cause: unknown, status = 500): InfraError {
  return new InfraError({
    errcode: "M_UNKNOWN",
    message,
    status,
    cause,
  });
}

export function createAccountDataQueryPorts(
  env: Pick<AppEnv["Bindings"], "DB" | "ACCOUNT_DATA" | "USER_KEYS">,
): AccountDataQueryPorts {
  return {
    getGlobalAccountData: (userId, eventType) =>
      loadGlobalAccountDataEffect(env, userId, eventType),
    getRoomAccountData: (userId, roomId, eventType) =>
      loadDatabaseAccountDataEffect(env, userId, roomId, eventType),
    isUserJoinedToRoom: (userId, roomId) =>
      Effect.tryPromise({
        try: () => isUserJoinedToRoom(env.DB, roomId, userId),
        catch: (cause) => toInfraError("Failed to verify room membership", cause),
      }),
  };
}

export function createAccountDataCommandPorts(
  env: Pick<AppEnv["Bindings"], "DB" | "ACCOUNT_DATA" | "USER_KEYS" | "SYNC">,
): AccountDataCommandPorts {
  return {
    putGlobalAccountData: (userId, eventType, content) =>
      persistGlobalAccountDataEffect(env, userId, eventType, content),
    deleteGlobalAccountData: (userId, eventType) =>
      deleteGlobalAccountDataEffect(env, userId, eventType),
    putRoomAccountData: (userId, roomId, eventType, content) =>
      persistRoomAccountDataEffect(env, userId, roomId, eventType, content),
    deleteRoomAccountData: (userId, roomId, eventType) =>
      deleteRoomAccountDataEffect(env, userId, roomId, eventType),
    isUserJoinedToRoom: (userId, roomId) =>
      Effect.tryPromise({
        try: () => isUserJoinedToRoom(env.DB, roomId, userId),
        catch: (cause) => toInfraError("Failed to verify room membership", cause),
      }),
    notifyAccountDataChange: ({ userId, roomId, eventType }) =>
      notifyAccountDataChangeEffect(env, { userId, roomId, eventType }),
  };
}
