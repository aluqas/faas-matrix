import type { JoinedRoom } from "../../../../types";
import type { SyncRepository } from "../../../repositories/interfaces";
import { projectJoinedRoom, shouldIncludeRoom } from "../../sync-projection";
import type { JoinedRoomProjectionQuery } from "../../sync-projection";

export interface RoomDeltaProjectionPorts {
  repository: SyncRepository;
}

export interface ProjectRoomDeltaInput {
  userId: string;
  roomIds: string[];
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
