import { Effect } from "effect";
import { executeKyselyBatch } from "../../../../services/kysely";
import type { AppEnv } from "../../../../types";
import {
  isDoBackedAccountDataEventType,
  type AccountDataContent,
} from "../../../../types/account-data";
import type { RoomId, UserId } from "../../../../types/matrix";
import {
  buildMarkAccountDataDeletedQuery,
  buildRecordAccountDataChangeQuery,
  buildUpsertAccountDataRecordQuery,
  getNextAccountDataStreamPosition,
} from "../../../repositories/account-data-repository";
import { InfraError } from "../../domain-error";
import {
  deleteE2EEAccountDataFromDO,
  putE2EEAccountDataToDO,
} from "./e2ee-gateway";

function toInfraError(message: string, cause: unknown, status = 500): InfraError {
  return new InfraError({
    errcode: "M_UNKNOWN",
    message,
    status,
    cause,
  });
}

async function persistDatabaseAccountDataRecord(
  db: D1Database,
  userId: UserId,
  roomId: RoomId | "",
  eventType: string,
  content: AccountDataContent,
): Promise<void> {
  const streamPosition = await getNextAccountDataStreamPosition(db);
  await executeKyselyBatch(db, [
    buildUpsertAccountDataRecordQuery(userId, roomId, eventType, JSON.stringify(content)),
    buildRecordAccountDataChangeQuery(userId, roomId, eventType, streamPosition),
  ]);
}

async function markDatabaseAccountDataDeleted(
  db: D1Database,
  userId: UserId,
  roomId: RoomId | "",
  eventType: string,
): Promise<void> {
  const streamPosition = await getNextAccountDataStreamPosition(db);
  await executeKyselyBatch(db, [
    buildMarkAccountDataDeletedQuery(userId, roomId, eventType),
    buildRecordAccountDataChangeQuery(userId, roomId, eventType, streamPosition),
  ]);
}

async function persistDoBackedGlobalAccountData(
  env: Pick<AppEnv["Bindings"], "ACCOUNT_DATA" | "USER_KEYS">,
  userId: UserId,
  eventType: string,
  content: AccountDataContent,
): Promise<void> {
  await putE2EEAccountDataToDO(env, userId, eventType, content);
  await env.ACCOUNT_DATA.put(`global:${userId}:${eventType}`, JSON.stringify(content));
}

async function deleteDoBackedGlobalAccountData(
  env: Pick<AppEnv["Bindings"], "ACCOUNT_DATA" | "USER_KEYS">,
  userId: UserId,
  eventType: string,
): Promise<void> {
  await deleteE2EEAccountDataFromDO(env, userId, eventType);
  await env.ACCOUNT_DATA.delete(`global:${userId}:${eventType}`);
}

export function persistGlobalAccountDataEffect(
  env: Pick<AppEnv["Bindings"], "DB" | "ACCOUNT_DATA" | "USER_KEYS">,
  userId: UserId,
  eventType: string,
  content: AccountDataContent,
): Effect.Effect<void, InfraError> {
  return Effect.tryPromise({
    try: async () => {
      if (isDoBackedAccountDataEventType(eventType)) {
        await persistDoBackedGlobalAccountData(env, userId, eventType, content);
      }
      await persistDatabaseAccountDataRecord(env.DB, userId, "", eventType, content);
    },
    catch: (cause) =>
      toInfraError(
        isDoBackedAccountDataEventType(eventType)
          ? "Failed to store E2EE account data"
          : "Failed to store global account data",
        cause,
        isDoBackedAccountDataEventType(eventType) ? 503 : 500,
      ),
  });
}

export function deleteGlobalAccountDataEffect(
  env: Pick<AppEnv["Bindings"], "DB" | "ACCOUNT_DATA" | "USER_KEYS">,
  userId: UserId,
  eventType: string,
): Effect.Effect<void, InfraError> {
  return Effect.tryPromise({
    try: async () => {
      if (isDoBackedAccountDataEventType(eventType)) {
        await deleteDoBackedGlobalAccountData(env, userId, eventType);
      }
      await markDatabaseAccountDataDeleted(env.DB, userId, "", eventType);
    },
    catch: (cause) => toInfraError("Failed to delete global account data", cause),
  });
}

export function persistRoomAccountDataEffect(
  env: Pick<AppEnv["Bindings"], "DB">,
  userId: UserId,
  roomId: RoomId,
  eventType: string,
  content: AccountDataContent,
): Effect.Effect<void, InfraError> {
  return Effect.tryPromise({
    try: async () => {
      await persistDatabaseAccountDataRecord(env.DB, userId, roomId, eventType, content);
    },
    catch: (cause) => toInfraError("Failed to store room account data", cause),
  });
}

export function deleteRoomAccountDataEffect(
  env: Pick<AppEnv["Bindings"], "DB">,
  userId: UserId,
  roomId: RoomId,
  eventType: string,
): Effect.Effect<void, InfraError> {
  return Effect.tryPromise({
    try: async () => {
      await markDatabaseAccountDataDeleted(env.DB, userId, roomId, eventType);
    },
    catch: (cause) => toInfraError("Failed to delete room account data", cause),
  });
}
