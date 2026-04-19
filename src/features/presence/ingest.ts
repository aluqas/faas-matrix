import { Effect } from "effect";
import type { FederationRepository } from "../../infra/repositories/interfaces";
import { InfraError } from "../../matrix/application/domain-error";
import { fromInfraVoid } from "../../shared/effect/infra-effect";
import type { PresenceState, UserId } from "../../shared/types";
import type { PresenceEduContent } from "./contracts";

export interface PresenceIngestEffectPorts {
  presenceStore: {
    upsertPresence(
      userId: UserId,
      presence: PresenceState,
      statusMessage: string | null,
      lastActiveTs: number,
      currentlyActive: boolean,
    ): Effect.Effect<void, InfraError>;
  };
}

function createCompatibilityPresenceIngestPorts(
  repository: Pick<FederationRepository, "upsertPresence">,
): PresenceIngestEffectPorts {
  return {
    presenceStore: {
      upsertPresence: (userId, presence, statusMessage, lastActiveTs, currentlyActive) =>
        fromInfraVoid(
          () =>
            Promise.resolve(
              repository.upsertPresence(
                userId,
                presence,
                statusMessage,
                lastActiveTs,
                currentlyActive,
              ),
            ),
          "Failed to apply presence EDU",
        ),
    },
  };
}

export function ingestPresenceEduEffect(
  ports: PresenceIngestEffectPorts,
  now: number,
  content: PresenceEduContent,
): Effect.Effect<void, InfraError> {
  return Effect.gen(function* () {
    if (!Array.isArray(content.push)) {
      return;
    }

    for (const update of content.push) {
      if (!update.user_id || !update.presence) {
        continue;
      }

      const lastActiveTs =
        typeof update.last_active_ago === "number" ? now - update.last_active_ago : now;
      yield* ports.presenceStore.upsertPresence(
        update.user_id,
        update.presence,
        update.status_msg ?? null,
        lastActiveTs,
        Boolean(update.currently_active),
      );
    }
  });
}

export async function ingestPresenceEdu(
  repository: Pick<FederationRepository, "upsertPresence">,
  now: number,
  content: PresenceEduContent,
): Promise<void> {
  await Effect.runPromise(
    ingestPresenceEduEffect(createCompatibilityPresenceIngestPorts(repository), now, content),
  );
}
