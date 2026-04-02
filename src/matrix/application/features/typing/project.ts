import { applyEventFilter } from "../../sync-projection";
import type { TypingProjectionQuery, TypingProjectionRepository } from "./contracts";

export async function projectTypingEphemeral(
  repository: TypingProjectionRepository,
  query: TypingProjectionQuery,
): Promise<Array<{ type: "m.typing"; content: { user_ids: string[] } }>> {
  const typingUsers = await repository.getTypingUsers(query.roomId);
  return applyEventFilter(
    typingUsers.length > 0 || query.includeEmpty
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
