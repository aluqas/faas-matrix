import { Effect } from "effect";
import type { Env } from "../../../env";
import type { NotifyAccountDataChangeInput } from "../../../../../fatrix-model/types/account-data";
import { notifySyncUser } from "../../realtime/sync-notify";
import { InfraError } from "../../../../../fatrix-backend/application/domain-error";
import { fromInfraVoid } from "../../../../../fatrix-backend/application/effect/infra-effect";

export function notifyAccountDataChangeEffect(
  env: Pick<Env, "SYNC">,
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
