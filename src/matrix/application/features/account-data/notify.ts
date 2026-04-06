import { Effect } from "effect";
import type { AppEnv } from "../../../../types";
import type { NotifyAccountDataChangeInput } from "../../../../types/account-data";
import { notifySyncUser } from "../../../../services/sync-notify";
import { InfraError } from "../../domain-error";

function toInfraError(message: string, cause: unknown, status = 500): InfraError {
  return new InfraError({
    errcode: "M_UNKNOWN",
    message,
    status,
    cause,
  });
}

export function notifyAccountDataChangeEffect(
  env: Pick<AppEnv["Bindings"], "SYNC">,
  input: NotifyAccountDataChangeInput,
): Effect.Effect<void, InfraError> {
  return Effect.tryPromise({
    try: () =>
      notifySyncUser(env, input.userId, {
        ...(input.roomId !== undefined ? { roomId: input.roomId } : {}),
        type: input.eventType,
      }),
    catch: (cause) => toInfraError("Failed to notify sync subscribers", cause),
  });
}
