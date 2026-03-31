import type { SyncEventFilter } from "../../sync-projection";

export interface TypingCommandInput {
  roomId: string;
  userId: string;
  typing: boolean;
  timeoutMs: number;
}

export interface TypingCommandPorts {
  setRoomTyping(roomId: string, userId: string, typing: boolean, timeoutMs?: number): Promise<void>;
  resolveInterestedServers(roomId: string): Promise<string[]>;
  queueEdu(destination: string, content: Record<string, unknown>): Promise<void>;
}

export interface TypingIngestPorts {
  getMembership(roomId: string, userId: string): Promise<string | null>;
  setRoomTyping(roomId: string, userId: string, typing: boolean, timeoutMs?: number): Promise<void>;
}

export interface TypingProjectionRepository {
  getTypingUsers(roomId: string): Promise<string[]>;
}

export interface TypingProjectionQuery {
  roomId: string;
  filter?: SyncEventFilter;
}
