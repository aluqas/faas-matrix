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
  roomIds: string[];
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
