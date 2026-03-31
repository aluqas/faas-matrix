import type { SyncEventFilter } from "../../sync-projection";
import type { PresenceState } from "../../../../types";

export interface PresenceCommandInput {
  userId: string;
  presence: PresenceState;
  statusMessage?: string | null;
  now: number;
}

export interface PresenceCommandPorts {
  persistPresence(input: PresenceCommandInput): Promise<void>;
  resolveInterestedServers(userId: string): Promise<string[]>;
  queueEdu(destination: string, content: Record<string, unknown>): Promise<void>;
  localServerName: string;
}

export interface PresenceSyncProjection {
  events: Array<{
    type: "m.presence";
    sender: string;
    content: {
      presence: PresenceState;
      status_msg?: string;
      last_active_ago?: number;
      currently_active?: boolean;
    };
  }>;
}

export interface PresenceProjectionQuery {
  userId: string;
  roomIds: string[];
  filter?: SyncEventFilter;
}
