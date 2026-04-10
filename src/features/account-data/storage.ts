import { Effect } from "effect";
import type { AppEnv } from "../../shared/types";
import type { AccountDataContent } from "../../shared/types/account-data";
import {
  isDoBackedAccountDataEventType,
  parseStoredAccountDataContent,
} from "../../shared/types/account-data";
import type { RoomId, UserId } from "../../shared/types/matrix";
import { findAccountDataRecord } from "../../infra/repositories/account-data-repository";
import { InfraError } from "../../matrix/application/domain-error";
import { requireLogContext, withLogContext } from "../../matrix/application/logging";
import { fromInfraNullable } from "../../shared/effect/infra-effect";
import { getKvTextValue } from "../shared/kv-gateway";
import { getE2EEAccountDataFromDO as loadE2EEAccountDataFromDO } from "./e2ee-gateway";
export { getE2EEAccountDataFromDO } from "./e2ee-gateway";
export { projectGlobalAccountDataSnapshot, projectRoomAccountDataSnapshot } from "./projector";

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
  return fromInfraNullable(async () => {
    const record = await findAccountDataRecord(env.DB, userId, roomId, eventType);
    return record && !record.deleted ? record.content : null;
  }, "Failed to load account data");
}

export function loadGlobalAccountDataEffect(
  env: Pick<AppEnv["Bindings"], "DB" | "ACCOUNT_DATA" | "USER_KEYS">,
  userId: UserId,
  eventType: string,
): Effect.Effect<AccountDataContent | null, InfraError> {
  return Effect.gen(function* () {
    if (isDoBackedAccountDataEventType(eventType)) {
      const doData = yield* Effect.catchAll(
        fromInfraNullable(
          () => loadE2EEAccountDataFromDO(env, userId, eventType),
          "Failed to load E2EE account data from DO",
        ),
        (error) =>
          logAccountDataFallbackEffect(userId, eventType, "do", error).pipe(
            Effect.zipRight(Effect.succeed<AccountDataContent | null>(null)),
          ),
      );
      if (doData) {
        return doData;
      }

      const kvData = yield* Effect.catchAll(
        fromInfraNullable(async () => {
          const stored = await getKvTextValue(env, "ACCOUNT_DATA", `global:${userId}:${eventType}`);
          return stored ? parseStoredAccountDataContent(stored) : null;
        }, "Failed to load E2EE account data from KV"),
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
