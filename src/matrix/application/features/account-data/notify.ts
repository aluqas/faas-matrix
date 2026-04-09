import { Effect } from "effect";
import type { AppEnv } from "../../../../types";
import type { NotifyAccountDataChangeInput } from "../../../../types/account-data";
import { notifySyncUser } from "../../../../services/sync-notify";
import { InfraError } from "../../domain-error";
import { fromInfraVoid } from "../../../lib/infra-effect";

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
