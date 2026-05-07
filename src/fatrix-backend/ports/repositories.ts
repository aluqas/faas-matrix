import type {
  AccountDataEvent,
  DeviceId,
  EphemeralEvent,
  EventId,
  Membership,
  PDU,
  Room,
  RoomId,
  StrippedStateEvent,
  ToDeviceEvent,
  UserId,
} from "../../fatrix-model/types";
import type { FilterDefinition } from "../../fatrix-model/types/filter";

export type { FilterDefinition };

export interface MembershipRecord {
  membership: Membership;
  eventId: EventId;
  streamOrdering?: number;
}

export type ReceiptEvent = EphemeralEvent;

export interface UnreadNotificationCounts {
  highlight_count: number;
  notification_count: number;
}

export interface UnreadNotificationSummary {
  room: UnreadNotificationCounts;
  main: UnreadNotificationCounts;
  threads: Record<string, UnreadNotificationCounts>;
}

export interface RoomRepository {
  getRoomByAlias(alias: string): Promise<string | null>;
  createRoom(
    roomId: RoomId,
    roomVersion: string,
    creatorId: UserId,
    isPublic: boolean,
  ): Promise<void>;
  createRoomAlias(alias: string, roomId: RoomId, creatorId: UserId): Promise<void>;
  upsertRoomAccountData(
    userId: UserId,
    roomId: RoomId,
    eventType: string,
    content: Record<string, unknown>,
  ): Promise<void>;
  storeEvent(event: PDU): Promise<void>;
  persistMembershipEvent(
    roomId: RoomId,
    event: PDU,
    source: "client" | "federation" | "workflow",
  ): Promise<void>;
  updateMembership(
    roomId: RoomId,
    userId: UserId,
    membership: Membership,
    eventId: EventId,
    displayName?: string,
    avatarUrl?: string,
  ): Promise<void>;
  notifyUsersOfEvent(roomId: RoomId, eventId: EventId, eventType: string): Promise<void>;
  getRoom(roomId: RoomId): Promise<Room | null>;
  getEvent(eventId: EventId): Promise<PDU | null>;
  getMembership(roomId: RoomId, userId: UserId): Promise<MembershipRecord | null>;
  getStateEvent(roomId: RoomId, eventType: string, stateKey?: string): Promise<PDU | null>;
  getLatestRoomEvents(roomId: RoomId, limit: number): Promise<PDU[]>;
  findLocalAuthorizingUser(roomId: RoomId, serverName: string): Promise<string | null>;
}

export interface SyncRepository {
  loadFilter(userId: UserId, filterParam?: string): Promise<FilterDefinition | null>;
  getLatestStreamPosition(): Promise<number>;
  getLatestDeviceKeyPosition(): Promise<number>;
  getToDeviceMessages(
    userId: UserId,
    deviceId: DeviceId,
    since: string,
  ): Promise<{ events: ToDeviceEvent[]; nextBatch: string }>;
  getOneTimeKeyCounts(userId: UserId, deviceId: DeviceId): Promise<Record<string, number>>;
  getUnusedFallbackKeyTypes(userId: UserId, deviceId: DeviceId): Promise<string[]>;
  getDeviceListChanges(
    userId: UserId,
    sinceEventPosition: number,
    sinceDeviceKeyPosition: number,
  ): Promise<{ changed: string[]; left: string[] }>;
  getGlobalAccountData(userId: UserId, since?: number): Promise<AccountDataEvent[]>;
  getRoomAccountData(userId: UserId, roomId: RoomId, since?: number): Promise<AccountDataEvent[]>;
  getUserRooms(userId: UserId, membership?: Membership): Promise<RoomId[]>;
  getMembership(roomId: RoomId, userId: UserId): Promise<MembershipRecord | null>;
  getEventsSince(roomId: RoomId, sincePosition: number): Promise<PDU[]>;
  getEvent(eventId: EventId): Promise<PDU | null>;
  getRoomState(roomId: RoomId): Promise<PDU[]>;
  getInviteStrippedState(roomId: RoomId): Promise<StrippedStateEvent[]>;
  getReceiptsForRoom(roomId: RoomId, userId: UserId): Promise<ReceiptEvent>;
  getUnreadNotificationSummary(roomId: RoomId, userId: UserId): Promise<UnreadNotificationSummary>;
  getTypingUsers(roomId: RoomId): Promise<UserId[]>;
  waitForUserEvents(userId: UserId, timeoutMs: number): Promise<{ hasEvents: boolean }>;
}

export interface FederationProcessedPdu {
  accepted: boolean;
  rejectionReason: string | null;
}

export interface FederationRepository {
  getCachedTransaction(origin: string, txnId: string): Promise<Record<string, unknown> | null>;
  storeCachedTransaction(
    origin: string,
    txnId: string,
    response: Record<string, unknown>,
  ): Promise<void>;
  getProcessedPdu(eventId: EventId): Promise<FederationProcessedPdu | null>;
  recordProcessedPdu(
    eventId: EventId,
    origin: string,
    roomId: RoomId,
    accepted: boolean,
    rejectionReason?: string,
  ): Promise<void>;
  createRoom(
    roomId: RoomId,
    roomVersion: string,
    creatorId: UserId,
    isPublic: boolean,
  ): Promise<void>;
  getRoom(roomId: RoomId): Promise<Room | null>;
  getEvent(eventId: EventId): Promise<PDU | null>;
  getLatestRoomEvents(roomId: RoomId, limit: number): Promise<PDU[]>;
  getRoomState(roomId: RoomId): Promise<PDU[]>;
  getInviteStrippedState(roomId: RoomId): Promise<StrippedStateEvent[]>;
  storeIncomingEvent(event: PDU): Promise<void>;
  notifyUsersOfEvent(roomId: RoomId, eventId: EventId, eventType: string): Promise<void>;
  updateMembership(
    roomId: RoomId,
    userId: UserId,
    membership: "join" | "invite" | "leave" | "ban" | "knock",
    eventId: EventId,
    displayName?: string,
    avatarUrl?: string,
  ): Promise<void>;
  upsertRoomState(
    roomId: RoomId,
    eventType: string,
    stateKey: string,
    eventId: EventId,
  ): Promise<void>;
  storeProcessedEdu(
    origin: string,
    eduType: string,
    content: Record<string, unknown>,
  ): Promise<void>;
  upsertPresence(
    userId: UserId,
    presence: string,
    statusMessage: string | null,
    lastActiveTs: number,
    currentlyActive: boolean,
  ): Promise<void>;
  upsertRemoteDeviceList(
    userId: UserId,
    deviceId: DeviceId,
    streamId: number,
    keys: Record<string, unknown> | null,
    displayName?: string,
    deleted?: boolean,
  ): Promise<void>;
}
