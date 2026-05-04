import { applyEventFilter } from "../../orchestrators/sync-projection";
import type { UserId } from "../../../../fatrix-model/types";
import { toUserId } from "../../../../fatrix-model/utils/ids";
import type { TypingProjectionQuery, TypingProjectionRepository } from "./contracts";

export function parseTypingUsersResponse(value: unknown): UserId[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  const data = value as { user_ids?: unknown };
  return Array.isArray(data.user_ids)
    ? data.user_ids
        .map((userId) => toUserId(userId))
        .filter((userId): userId is UserId => userId !== null)
    : [];
}

export async function projectTypingEphemeral(
  repository: TypingProjectionRepository,
  query: TypingProjectionQuery,
): Promise<Array<{ type: "m.typing"; content: { user_ids: string[] } }>> {
  const typingUsers = await repository.getTypingUsers(query.roomId);
  return applyEventFilter(
    typingUsers.length > 0
      ? [
          {
            type: "m.typing" as const,
            content: { user_ids: typingUsers },
          },
        ]
      : [],
    query.filter,
  );
}
