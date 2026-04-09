import { applyEventFilter } from "../../matrix/application/orchestrators/sync-projection";
import type { AppEnv, RoomId, UserId } from "../../shared/types";
import { toUserId } from "../../shared/utils/ids";
import { getRoomTypingState } from "../shared/room-do-gateway";
import type { TypingProjectionQuery, TypingProjectionRepository } from "./contracts";

function parseTypingUsersResponse(value: unknown): UserId[] {
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

export async function getTypingUsers(
  env: Pick<AppEnv["Bindings"], "ROOMS">,
  roomId: RoomId,
): Promise<UserId[]> {
  return parseTypingUsersResponse(await getRoomTypingState(env, roomId));
}

export async function getTypingForRooms(
  env: Pick<AppEnv["Bindings"], "ROOMS">,
  roomIds: RoomId[],
): Promise<Record<RoomId, UserId[]>> {
  if (roomIds.length === 0) {
    return {};
  }

  const byRoom: Partial<Record<RoomId, UserId[]>> = {};
  const results = await Promise.all(
    roomIds.map(async (roomId) => {
      try {
        return { roomId, users: await getTypingUsers(env, roomId) };
      } catch {
        return { roomId, users: [] };
      }
    }),
  );

  for (const { roomId, users } of results) {
    if (users.length > 0) {
      byRoom[roomId] = users;
    }
  }

  return byRoom as Record<RoomId, UserId[]>;
}
