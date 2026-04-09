import type { JoinedRoom, RoomId, UserId } from "../../shared/types";
import type { SyncRepository } from "../../infra/repositories/interfaces";
import type { JoinedRoomProjectionQuery } from "../../matrix/application/orchestrators/sync-projection";
import {
  projectJoinedRoom,
  shouldIncludeRoom,
} from "../../matrix/application/orchestrators/sync-projection";

export interface RoomDeltaProjectionPorts {
  repository: SyncRepository;
}

export interface ProjectRoomDeltaInput {
  userId: UserId;
  roomIds: RoomId[];
  sincePosition: number;
  fullState?: boolean;
  roomFilter?: JoinedRoomProjectionQuery["roomFilter"];
}

export function hasJoinedRoomDelta(room: JoinedRoom): boolean {
  return (
    (room.timeline?.events.length ?? 0) > 0 ||
    (room.state?.events.length ?? 0) > 0 ||
    (room.ephemeral?.events.length ?? 0) > 0 ||
    (room.account_data?.events.length ?? 0) > 0
  );
}

export async function projectRoomDeltas(
  ports: RoomDeltaProjectionPorts,
  input: ProjectRoomDeltaInput,
): Promise<Record<string, JoinedRoom>> {
  const joinedRooms: Record<string, JoinedRoom> = {};

  for (const roomId of input.roomIds) {
    if (!shouldIncludeRoom(roomId, input.roomFilter)) {
      continue;
    }

    joinedRooms[roomId] = await projectJoinedRoom(ports.repository, {
      userId: input.userId,
      roomId,
      sincePosition: input.sincePosition,
      ...(input.fullState !== undefined ? { fullState: input.fullState } : {}),
      ...(input.roomFilter ? { roomFilter: input.roomFilter } : {}),
    });
  }

  return joinedRooms;
}
