import type { SyncEventFilter } from "../../sync-projection";
import type { PresenceEvent, PresenceState } from "../../../../types";

export interface PresenceCommandInput {
  userId: string;
  presence: PresenceState;
  statusMessage?: string | null;
  now: number;
}

export interface PresenceEduUpdate {
  user_id: string;
  presence: PresenceState;
  status_msg?: string | undefined;
  last_active_ago?: number | undefined;
  currently_active?: boolean | undefined;
}

export interface PresenceEduContent {
  push: PresenceEduUpdate[];
}

export interface PresenceCommandPorts {
  persistPresence(input: PresenceCommandInput): Promise<void>;
  resolveInterestedServers(userId: string): Promise<string[]>;
  queueEdu(destination: string, content: PresenceEduContent): Promise<void>;
  localServerName: string;
  debugEnabled?: boolean | undefined;
}

export interface PresenceSyncProjection {
  events: PresenceEvent[];
}

export interface PresenceProjectionQuery {
  userId: string;
  /**
   * Canonical visibility scope: all rooms the requesting user is currently joined to.
   * Presence events are projected for every user who shares at least one of these rooms.
   *
   * Must be ALL joined rooms (not just the sliding-sync window) so that users sharing
   * rooms outside the current response window still appear in presence output.
   */
  visibleRoomIds: string[];
  filter?: SyncEventFilter | undefined;
  debugEnabled?: boolean | undefined;
}

/**
 * Port for reading and projecting presence data.
 * Allows sync/sliding-sync paths to share the same visible-user definition.
 */
export interface PresenceProjectionPort {
  projectEvents(query: PresenceProjectionQuery): Promise<PresenceSyncProjection>;
}

/**
 * Port for persisting presence state.
 * Abstracts D1 + KV upsert behind a single call.
 */
export interface PresenceWritePort {
  persistPresence(input: PresenceCommandInput): Promise<void>;
}
