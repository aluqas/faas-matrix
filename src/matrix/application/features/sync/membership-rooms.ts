import type { SyncRepository } from "../../../repositories/interfaces";
import {
  projectMembershipRooms,
  type SyncProjectionQuery,
  type SyncProjectionResult,
} from "../../sync-projection";

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
