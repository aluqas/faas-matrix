import type { FederationRepository } from "../../infra/repositories/interfaces";
import type { PresenceEduContent } from "./contracts";

export async function ingestPresenceEdu(
  repository: Pick<FederationRepository, "upsertPresence">,
  now: number,
  content: PresenceEduContent,
): Promise<void> {
  if (!Array.isArray(content.push)) {
    return;
  }

  for (const update of content.push) {
    if (!update.user_id || !update.presence) {
      continue;
    }

    const lastActiveTs =
      typeof update.last_active_ago === "number" ? now - update.last_active_ago : now;
    await repository.upsertPresence(
      update.user_id,
      update.presence,
      update.status_msg ?? null,
      lastActiveTs,
      Boolean(update.currently_active),
    );
  }
}
