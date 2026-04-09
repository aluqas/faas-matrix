import { Effect } from "effect";
import type { PresenceState, UserId } from "../../shared/types";
import { Errors, type MatrixApiError } from "../../shared/utils/errors";
import { InfraError } from "../../matrix/application/domain-error";

export interface PresenceStatusResult {
  presence: PresenceState;
  statusMsg?: string;
  lastActiveAgo?: number;
  currentlyActive: boolean;
}

export interface PresenceQueryPorts {
  userDirectory: {
    userExists(userId: UserId): Effect.Effect<boolean, InfraError>;
  };
  presenceStore: {
    getPresence(userId: UserId): Effect.Effect<PresenceStatusResult | null, InfraError>;
  };
}

export function getPresenceStatusEffect(
  ports: PresenceQueryPorts,
  input: { userId: UserId },
): Effect.Effect<PresenceStatusResult, MatrixApiError | InfraError> {
  return Effect.gen(function* () {
    const exists = yield* ports.userDirectory.userExists(input.userId);
    if (!exists) {
      return yield* Effect.fail(Errors.notFound("User not found"));
    }

    const presence = yield* ports.presenceStore.getPresence(input.userId);
    return (
      presence ?? {
        presence: "offline",
        currentlyActive: false,
      }
    );
  });
}
