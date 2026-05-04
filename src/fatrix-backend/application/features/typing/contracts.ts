import type { SyncEventFilter } from "../../orchestrators/sync-projection";

export interface TypingCommandInput {
  roomId: string;
  userId: string;
  typing: boolean;
  timeoutMs: number;
}

export interface TypingEduContent {
  room_id: string;
  user_id: string;
  typing: boolean;
  timeout?: number | undefined;
}

export interface TypingCommandPorts {
  setRoomTyping(roomId: string, userId: string, typing: boolean, timeoutMs?: number): Promise<void>;
  resolveInterestedServers(roomId: string): Promise<string[]>;
  queueEdu(destination: string, content: TypingEduContent): Promise<void>;
  debugEnabled?: boolean | undefined;
}

export interface TypingIngestPorts {
  getMembership(roomId: string, userId: string): Promise<string | null>;
  isPartialStateRoom?(roomId: string): Promise<boolean>;
  setRoomTyping(roomId: string, userId: string, typing: boolean, timeoutMs?: number): Promise<void>;
}

export interface TypingProjectionRepository {
  getTypingUsers(roomId: string): Promise<string[]>;
}

export interface TypingProjectionQuery {
  roomId: string;
  includeEmpty?: boolean | undefined;
  filter?: SyncEventFilter | undefined;
  debugEnabled?: boolean | undefined;
}
