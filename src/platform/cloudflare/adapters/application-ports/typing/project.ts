import type { RoomId, UserId } from "../../../../../fatrix-model/types";
import type { Env } from "../../../env";
import { parseTypingUsersResponse } from "../../../../../fatrix-backend/application/features/typing/project";
import { getRoomTypingState } from "../shared/room-do-gateway";

export async function getTypingUsers(env: Pick<Env, "ROOMS">, roomId: RoomId): Promise<UserId[]> {
  return parseTypingUsersResponse(await getRoomTypingState(env, roomId));
}

export async function getTypingForRooms(
  env: Pick<Env, "ROOMS">,
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
