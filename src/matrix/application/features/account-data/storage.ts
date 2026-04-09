import { Effect } from "effect";
import type { AppEnv } from "../../../../types";
import type { AccountDataContent } from "../../../../types/account-data";
import {
  isDoBackedAccountDataEventType,
  parseStoredAccountDataContent,
} from "../../../../types/account-data";
import type { RoomId, UserId } from "../../../../types/matrix";
import {
  findAccountDataRecord,
} from "../../../repositories/account-data-repository";
import { InfraError } from "../../domain-error";
import { requireLogContext, withLogContext } from "../../logging";
import { getE2EEAccountDataFromDO as loadE2EEAccountDataFromDO } from "./e2ee-gateway";
export { getE2EEAccountDataFromDO } from "./e2ee-gateway";
export {
  projectGlobalAccountDataSnapshot,
  projectRoomAccountDataSnapshot,
} from "./projector";

function toInfraError(message: string, cause: unknown, status = 500): InfraError {
  return new InfraError({
    errcode: "M_UNKNOWN",
    message,
    status,
    cause,
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

export function loadDatabaseAccountDataEffect(
  env: Pick<AppEnv["Bindings"], "DB">,
  userId: UserId,
  roomId: RoomId | "",
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

export function loadGlobalAccountDataEffect(
  env: Pick<AppEnv["Bindings"], "DB" | "ACCOUNT_DATA" | "USER_KEYS">,
  userId: UserId,
  eventType: string,
): Effect.Effect<AccountDataContent | null, InfraError> {
  return Effect.gen(function* () {
    if (isDoBackedAccountDataEventType(eventType)) {
      const doData = yield* Effect.catchAll(
        Effect.tryPromise({
          try: () => loadE2EEAccountDataFromDO(env, userId, eventType),
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
