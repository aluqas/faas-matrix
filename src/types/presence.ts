import type { PresenceEvent, PresenceState } from "./matrix";
import type { SyncEventFilter } from "./sync";

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
  visibleRoomIds: string[];
  filter?: SyncEventFilter | undefined;
  debugEnabled?: boolean | undefined;
}

export interface PresenceProjectionPort {
  projectEvents(query: PresenceProjectionQuery): Promise<PresenceSyncProjection>;
}

export interface PresenceWritePort {
  persistPresence(input: PresenceCommandInput): Promise<void>;
}
