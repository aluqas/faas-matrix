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
import { requireLogContext, withLogContext } from "../../logging";
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

function loadDatabaseAccountDataEffect(
  env: Pick<AppEnv["Bindings"], "DB">,
  userId: UserId,
  roomId: string,
  eventType: string,
): Effect.Effect<AccountDataContent | null, InfraError> {
  return Effect.tryPromise({
    try: async () => {
      const record = await findAccountDataRecord(env.DB, userId, roomId, eventType);
      return record && !record.deleted ? record.content : null;
    },
    catch: (cause) => toInfraError("Failed to load account data", cause),
  });
}

function logAccountDataFallbackEffect(
  userId: UserId,
  eventType: string,
  source: "do" | "kv",
  cause: unknown,
): Effect.Effect<void> {
  const logger = withLogContext(
    requireLogContext(
      "account_data.global_fallback",
      {
        component: "account_data",
        operation: "global_fallback",
        user_id: userId,
      },
      ["user_id"],
    ),
  );

  return logger.warn("account_data.global.fallback", {
    event_type: eventType,
    fallback_source: source,
    error_message: cause instanceof Error ? cause.message : String(cause),
  });
}

function loadGlobalAccountDataEffect(
  env: Pick<AppEnv["Bindings"], "DB" | "ACCOUNT_DATA" | "USER_KEYS">,
  userId: UserId,
  eventType: string,
): Effect.Effect<AccountDataContent | null, InfraError> {
  return Effect.gen(function* () {
    if (isDoBackedAccountDataEventType(eventType)) {
      const doData = yield* Effect.catchAll(
        Effect.tryPromise({
          try: () => getE2EEAccountDataFromDO(env, userId, eventType),
          catch: (cause) => toInfraError("Failed to load E2EE account data from DO", cause),
        }),
        (error) =>
          logAccountDataFallbackEffect(userId, eventType, "do", error).pipe(
            Effect.zipRight(Effect.succeed<AccountDataContent | null>(null)),
          ),
      );

      if (doData) {
        return doData;
      }

      const kvData = yield* Effect.catchAll(
        Effect.tryPromise({
          try: async () => {
            const stored = await env.ACCOUNT_DATA.get(`global:${userId}:${eventType}`);
            return stored ? parseStoredAccountDataContent(stored) : null;
          },
          catch: (cause) => toInfraError("Failed to load E2EE account data from KV", cause),
        }),
        (error) =>
          logAccountDataFallbackEffect(userId, eventType, "kv", error).pipe(
            Effect.zipRight(Effect.succeed<AccountDataContent | null>(null)),
          ),
      );

      if (kvData) {
        return kvData;
      }
    }

    return yield* loadDatabaseAccountDataEffect(env, userId, "", eventType);
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
