import type { SyncRepository } from "../../../../ports/repositories";
import {
  projectMembershipRooms,
  type SyncProjectionQuery,
  type SyncProjectionResult,
} from "../../../orchestrators/sync-projection";

export interface MembershipRoomsProjectionPorts {
  repository: SyncRepository;
}

export type ProjectMembershipRoomsInput = SyncProjectionQuery;

export function projectMembershipRoomBuckets(
  ports: MembershipRoomsProjectionPorts,
  input: ProjectMembershipRoomsInput,
): Promise<SyncProjectionResult> {
  return projectMembershipRooms(ports.repository, input);
}
