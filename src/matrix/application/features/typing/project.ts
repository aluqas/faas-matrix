import { applyEventFilter } from "../../sync-projection";
import { runClientEffect } from "../../effect-runtime";
import { withLogContext } from "../../logging";
import type { TypingProjectionQuery, TypingProjectionRepository } from "./contracts";

export async function projectTypingEphemeral(
  repository: TypingProjectionRepository,
  query: TypingProjectionQuery,
): Promise<Array<{ type: "m.typing"; content: { user_ids: string[] } }>> {
  const logger = withLogContext({
    component: "typing",
    operation: "project",
    room_id: query.roomId,
    debugEnabled: query.debugEnabled,
  });
  const typingUsers = await repository.getTypingUsers(query.roomId);
  if (typingUsers.length === 0) {
    await runClientEffect(logger.debug("typing.project.result", { user_count: 0 }));
    return [];
  }

  const projection = applyEventFilter(
    [
      {
        type: "m.typing" as const,
        content: { user_ids: typingUsers },
      },
    ],
    query.filter,
  );
  await runClientEffect(
    logger.debug("typing.project.result", {
      user_count: typingUsers.length,
      event_count: projection.length,
    }),
  );

  return projection;
}
