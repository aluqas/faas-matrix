import type { SyncRepository } from "../../infra/repositories/interfaces";
import {
  projectMembershipRooms,
  type SyncProjectionQuery,
  type SyncProjectionResult,
} from "../../matrix/application/orchestrators/sync-projection";

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
