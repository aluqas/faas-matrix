import type { PresenceEvent, PresenceState, ServerName, UserId } from "./matrix";
import type { SyncEventFilter } from "./sync";

export interface PresenceCommandInput {
  userId: UserId;
  presence: PresenceState;
  statusMessage?: string | null;
  now: number;
}

export interface PresenceEduUpdate {
  user_id: UserId;
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
  resolveInterestedServers(userId: UserId): Promise<ServerName[]>;
  queueEdu(destination: ServerName, content: PresenceEduContent): Promise<void>;
  localServerName: ServerName;
  debugEnabled?: boolean | undefined;
}

export interface PresenceProjectionResult {
  events: PresenceEvent[];
}

export interface PresenceProjectionQuery {
  userId: UserId;
  visibleRoomIds: import("./matrix").RoomId[];
  filter?: SyncEventFilter | undefined;
  debugEnabled?: boolean | undefined;
}

export interface PresenceProjectionPort {
  projectEvents(query: PresenceProjectionQuery): Promise<PresenceProjectionResult>;
}

export interface PresenceWritePort {
  persistPresence(input: PresenceCommandInput): Promise<void>;
}
