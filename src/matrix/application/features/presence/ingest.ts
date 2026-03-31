import type { FederationRepository } from "../../../repositories/interfaces";

export async function ingestPresenceEdu(
  repository: Pick<FederationRepository, "upsertPresence">,
  now: number,
  content: Record<string, unknown>,
): Promise<void> {
  const presencePush = content.push as
    | Array<{
        user_id: string;
        presence: string;
        status_msg?: string;
        last_active_ago?: number;
        currently_active?: boolean;
      }>
    | undefined;

  if (!presencePush) {
    return;
  }

  for (const update of presencePush) {
    if (!update.user_id || !update.presence) {
      continue;
    }

    const lastActiveTs =
      typeof update.last_active_ago === "number" ? now - update.last_active_ago : now;
    await repository.upsertPresence(
      update.user_id,
      update.presence,
      update.status_msg || null,
      lastActiveTs,
      Boolean(update.currently_active),
    );
  }
}
