import { Effect } from "effect";
import { executeKyselyBatch } from "../../infra/db/kysely";
import type { AppEnv } from "../../shared/types";
import {
  isDoBackedAccountDataEventType,
  type AccountDataContent,
} from "../../shared/types/account-data";
import type { RoomId, UserId } from "../../shared/types/matrix";
import {
  buildMarkAccountDataDeletedQuery,
  buildRecordAccountDataChangeQuery,
  buildUpsertAccountDataRecordQuery,
  getNextAccountDataStreamPosition,
} from "../../infra/repositories/account-data-repository";
import { InfraError } from "../../matrix/application/domain-error";
import { fromInfraVoid, toInfraError } from "../../shared/effect/infra-effect";
import { deleteKvValue, putKvTextValue } from "../shared/kv-gateway";
import { deleteE2EEAccountDataFromDO, putE2EEAccountDataToDO } from "./e2ee-gateway";

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
  await putKvTextValue(
    env,
    "ACCOUNT_DATA",
    `global:${userId}:${eventType}`,
    JSON.stringify(content),
  );
}

async function deleteDoBackedGlobalAccountData(
  env: Pick<AppEnv["Bindings"], "ACCOUNT_DATA" | "USER_KEYS">,
  userId: UserId,
  eventType: string,
): Promise<void> {
  await deleteE2EEAccountDataFromDO(env, userId, eventType);
  await deleteKvValue(env, "ACCOUNT_DATA", `global:${userId}:${eventType}`);
}

export function persistGlobalAccountDataEffect(
  env: Pick<AppEnv["Bindings"], "DB" | "ACCOUNT_DATA" | "USER_KEYS">,
  userId: UserId,
  eventType: string,
  content: AccountDataContent,
): Effect.Effect<void, InfraError> {
  return fromInfraVoid(async () => {
    if (isDoBackedAccountDataEventType(eventType)) {
      await persistDoBackedGlobalAccountData(env, userId, eventType, content);
    }
    await persistDatabaseAccountDataRecord(env.DB, userId, "", eventType, content);
  }, "Failed to store account data").pipe(
    Effect.mapError((cause) =>
      toInfraError(
        isDoBackedAccountDataEventType(eventType)
          ? "Failed to store E2EE account data"
          : "Failed to store global account data",
        cause,
        isDoBackedAccountDataEventType(eventType) ? 503 : 500,
      ),
    ),
  );
}

export function deleteGlobalAccountDataEffect(
  env: Pick<AppEnv["Bindings"], "DB" | "ACCOUNT_DATA" | "USER_KEYS">,
  userId: UserId,
  eventType: string,
): Effect.Effect<void, InfraError> {
  return fromInfraVoid(async () => {
    if (isDoBackedAccountDataEventType(eventType)) {
      await deleteDoBackedGlobalAccountData(env, userId, eventType);
    }
    await markDatabaseAccountDataDeleted(env.DB, userId, "", eventType);
  }, "Failed to delete global account data");
}

export function persistRoomAccountDataEffect(
  env: Pick<AppEnv["Bindings"], "DB">,
  userId: UserId,
  roomId: RoomId,
  eventType: string,
  content: AccountDataContent,
): Effect.Effect<void, InfraError> {
  return fromInfraVoid(async () => {
    await persistDatabaseAccountDataRecord(env.DB, userId, roomId, eventType, content);
  }, "Failed to store room account data");
}

export function deleteRoomAccountDataEffect(
  env: Pick<AppEnv["Bindings"], "DB">,
  userId: UserId,
  roomId: RoomId,
  eventType: string,
): Effect.Effect<void, InfraError> {
  return fromInfraVoid(async () => {
    await markDatabaseAccountDataDeleted(env.DB, userId, roomId, eventType);
  }, "Failed to delete room account data");
}
