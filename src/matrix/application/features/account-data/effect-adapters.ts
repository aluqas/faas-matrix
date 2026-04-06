import { Effect } from "effect";
import type { AppEnv, Env } from "../../../../types";
import type { AccountDataContent, E2EEAccountDataMap } from "../../../../types/account-data";
import {
  isDoBackedAccountDataEventType,
  normalizeE2EEAccountDataMap,
  parseStoredAccountDataContent,
} from "../../../../types/account-data";
import type { UserId } from "../../../../types/matrix";
import { notifySyncUser } from "../../../../services/sync-notify";
import {
  findAccountDataRecord,
  markAccountDataDeleted,
  recordAccountDataChange,
  upsertAccountDataRecord,
} from "../../../repositories/account-data-repository";
import { isUserJoinedToRoom } from "../../../repositories/membership-repository";
import { InfraError } from "../../domain-error";
import type { AccountDataCommandPorts } from "./command";
import type { AccountDataQueryPorts } from "./query";

function toInfraError(message: string, cause: unknown, status = 500): InfraError {
  return new InfraError({
    errcode: "M_UNKNOWN",
    message,
    status,
    cause,
  });
}

function getUserKeysDO(env: Pick<Env, "USER_KEYS">, userId: string): DurableObjectStub {
  const id = env.USER_KEYS.idFromName(userId);
  return env.USER_KEYS.get(id);
}

export async function getE2EEAccountDataFromDO(
  env: Pick<Env, "USER_KEYS">,
  userId: string,
): Promise<E2EEAccountDataMap>;
export async function getE2EEAccountDataFromDO(
  env: Pick<Env, "USER_KEYS">,
  userId: string,
  eventType: string,
): Promise<AccountDataContent | null>;
export async function getE2EEAccountDataFromDO(
  env: Pick<Env, "USER_KEYS">,
  userId: string,
  eventType?: string,
): Promise<E2EEAccountDataMap | AccountDataContent | null> {
  const stub = getUserKeysDO(env, userId);
  const url = eventType
    ? `http://internal/account-data/get?event_type=${encodeURIComponent(eventType)}`
    : "http://internal/account-data/get";
  const response = await stub.fetch(new Request(url));

  if (!response.ok) {
    const errorText = await response.text().catch(() => "unknown error");
    throw new Error(`DO get failed: ${response.status} - ${errorText}`);
  }

  const payload = (await response.json()) as unknown;
  if (eventType !== undefined) {
    return normalizeE2EEAccountDataMap({ [eventType]: payload })[eventType] ?? null;
  }
  return normalizeE2EEAccountDataMap(payload);
}

async function putE2EEAccountDataToDO(
  env: Pick<Env, "USER_KEYS">,
  userId: string,
  eventType: string,
  content: AccountDataContent,
): Promise<void> {
  const stub = getUserKeysDO(env, userId);
  const response = await stub.fetch(
    new Request("http://internal/account-data/put", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event_type: eventType, content }),
    }),
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => "unknown error");
    throw new Error(`DO put failed: ${response.status} - ${errorText}`);
  }
}

async function deleteE2EEAccountDataFromDO(
  env: Pick<Env, "USER_KEYS">,
  userId: string,
  eventType: string,
): Promise<void> {
  const stub = getUserKeysDO(env, userId);
  const response = await stub.fetch(
    new Request("http://internal/account-data/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event_type: eventType }),
    }),
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => "unknown error");
    throw new Error(`DO delete failed: ${response.status} - ${errorText}`);
  }
}

function loadGlobalAccountDataEffect(
  env: Pick<AppEnv["Bindings"], "DB" | "ACCOUNT_DATA" | "USER_KEYS">,
  userId: UserId,
  eventType: string,
): Effect.Effect<AccountDataContent | null, InfraError> {
  return Effect.tryPromise({
    try: async () => {
      if (isDoBackedAccountDataEventType(eventType)) {
        try {
          const doData = await getE2EEAccountDataFromDO(env, userId, eventType);
          if (doData) {
            return doData;
          }
        } catch (cause) {
          console.error("[account-data] DO unavailable, trying fallbacks:", cause);
        }

        try {
          const kvData = await env.ACCOUNT_DATA.get(`global:${userId}:${eventType}`);
          if (kvData) {
            return parseStoredAccountDataContent(kvData);
          }
        } catch (cause) {
          console.error("[account-data] KV fallback failed:", cause);
        }
      }

      const record = await findAccountDataRecord(env.DB, userId, "", eventType);
      return record && !record.deleted ? record.content : null;
    },
    catch: (cause) => toInfraError("Failed to load global account data", cause),
  });
}

export function createAccountDataQueryPorts(
  env: Pick<AppEnv["Bindings"], "DB" | "ACCOUNT_DATA" | "USER_KEYS">,
): AccountDataQueryPorts {
  return {
    getGlobalAccountData: (userId, eventType) =>
      loadGlobalAccountDataEffect(env, userId, eventType),
    getRoomAccountData: (userId, roomId, eventType) =>
      Effect.tryPromise({
        try: async () => {
          const record = await findAccountDataRecord(env.DB, userId, roomId, eventType);
          return record && !record.deleted ? record.content : null;
        },
        catch: (cause) => toInfraError("Failed to load room account data", cause),
      }),
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
      Effect.tryPromise({
        try: async () => {
          if (isDoBackedAccountDataEventType(eventType)) {
            await putE2EEAccountDataToDO(env, userId, eventType, content);
            await env.ACCOUNT_DATA.put(`global:${userId}:${eventType}`, JSON.stringify(content));
          }
          await upsertAccountDataRecord(env.DB, userId, "", eventType, JSON.stringify(content));
          await recordAccountDataChange(env.DB, userId, "", eventType);
        },
        catch: (cause) =>
          toInfraError(
            isDoBackedAccountDataEventType(eventType)
              ? "Failed to store E2EE account data"
              : "Failed to store global account data",
            cause,
            isDoBackedAccountDataEventType(eventType) ? 503 : 500,
          ),
      }),
    deleteGlobalAccountData: (userId, eventType) =>
      Effect.tryPromise({
        try: async () => {
          if (isDoBackedAccountDataEventType(eventType)) {
            await deleteE2EEAccountDataFromDO(env, userId, eventType);
            await env.ACCOUNT_DATA.delete(`global:${userId}:${eventType}`);
          }
          await markAccountDataDeleted(env.DB, userId, "", eventType);
          await recordAccountDataChange(env.DB, userId, "", eventType);
        },
        catch: (cause) => toInfraError("Failed to delete global account data", cause),
      }),
    putRoomAccountData: (userId, roomId, eventType, content) =>
      Effect.tryPromise({
        try: async () => {
          await upsertAccountDataRecord(env.DB, userId, roomId, eventType, JSON.stringify(content));
          await recordAccountDataChange(env.DB, userId, roomId, eventType);
        },
        catch: (cause) => toInfraError("Failed to store room account data", cause),
      }),
    deleteRoomAccountData: (userId, roomId, eventType) =>
      Effect.tryPromise({
        try: async () => {
          await markAccountDataDeleted(env.DB, userId, roomId, eventType);
          await recordAccountDataChange(env.DB, userId, roomId, eventType);
        },
        catch: (cause) => toInfraError("Failed to delete room account data", cause),
      }),
    isUserJoinedToRoom: (userId, roomId) =>
      Effect.tryPromise({
        try: () => isUserJoinedToRoom(env.DB, roomId, userId),
        catch: (cause) => toInfraError("Failed to verify room membership", cause),
      }),
    notifyAccountDataChange: ({ userId, roomId, eventType }) =>
      Effect.tryPromise({
        try: () =>
          notifySyncUser(env, userId, {
            ...(roomId !== undefined ? { roomId } : {}),
            type: eventType,
          }),
        catch: (cause) => toInfraError("Failed to notify sync subscribers", cause),
      }),
  };
}
