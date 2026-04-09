import { Effect } from "effect";
import type { AppEnv } from "../../shared/types";
import type { NotifyAccountDataChangeInput } from "../../shared/types/account-data";
import { notifySyncUser } from "../../infra/realtime/sync-notify";
import { InfraError } from "../../matrix/application/domain-error";
import { fromInfraVoid } from "../../shared/effect/infra-effect";

export function notifyAccountDataChangeEffect(
  env: Pick<AppEnv["Bindings"], "SYNC">,
  input: NotifyAccountDataChangeInput,
): Effect.Effect<void, InfraError> {
  return fromInfraVoid(
    () =>
      notifySyncUser(env, input.userId, {
        ...(input.roomId !== undefined ? { roomId: input.roomId } : {}),
        type: input.eventType,
      }),
    "Failed to notify sync subscribers",
  );
}
