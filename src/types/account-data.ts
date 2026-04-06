import type { JsonObject } from "./common";
import { isJsonObject } from "./common";
import type { RoomId, UserId } from "./matrix";
import type { AccountDataEventOf } from "./matrix-typed";

export type AccountDataEventType = string;
export type AccountDataContent = JsonObject;
export type AccountDataSyncEvent = AccountDataEventOf;
export type E2EEAccountDataMap = Record<string, AccountDataContent>;

export interface StoredAccountDataRecord {
  userId: UserId;
  roomId: RoomId | "";
  eventType: AccountDataEventType;
  content: AccountDataContent;
  deleted: boolean;
}

export interface GetGlobalAccountDataInput {
  authUserId: UserId;
  targetUserId: UserId;
  eventType: AccountDataEventType;
}

export interface PutGlobalAccountDataInput {
  authUserId: UserId;
  targetUserId: UserId;
  eventType: AccountDataEventType;
  content: AccountDataContent;
}

export interface DeleteGlobalAccountDataInput {
  authUserId: UserId;
  targetUserId: UserId;
  eventType: AccountDataEventType;
}

export interface GetRoomAccountDataInput {
  authUserId: UserId;
  targetUserId: UserId;
  roomId: RoomId;
  eventType: AccountDataEventType;
}

export interface PutRoomAccountDataInput {
  authUserId: UserId;
  targetUserId: UserId;
  roomId: RoomId;
  eventType: AccountDataEventType;
  content: AccountDataContent;
}

export interface DeleteRoomAccountDataInput {
  authUserId: UserId;
  targetUserId: UserId;
  roomId: RoomId;
  eventType: AccountDataEventType;
}

export interface NotifyAccountDataChangeInput {
  userId: UserId;
  eventType: AccountDataEventType;
  roomId?: RoomId;
}

export function isDoBackedAccountDataEventType(eventType: string): boolean {
  return (
    eventType.startsWith("m.secret_storage") ||
    eventType.startsWith("m.cross_signing") ||
    eventType === "m.megolm_backup.v1"
  );
}

export function isEmptyAccountDataContent(content: AccountDataContent): boolean {
  return Object.keys(content).length === 0;
}

export function parseStoredAccountDataContent(raw: string | null): AccountDataContent {
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return isJsonObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function normalizeE2EEAccountDataMap(raw: unknown): E2EEAccountDataMap {
  if (!isJsonObject(raw)) {
    return {};
  }

  const normalized: E2EEAccountDataMap = {};
  for (const [eventType, content] of Object.entries(raw)) {
    if (isJsonObject(content)) {
      normalized[eventType] = content;
    }
  }
  return normalized;
}
