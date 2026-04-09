import type {
  AccountDataEvent,
  EphemeralEvent,
  EventId,
  Membership,
  PDU,
  Room,
  RoomId,
  StrippedStateEvent,
  ToDeviceEvent,
  UserId,
} from "../../types";

export interface MembershipRecord {
  membership: Membership;
  eventId: string;
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

export interface FilterDefinition {
  room?: {
    rooms?: string[];
    not_rooms?: string[];
    timeline?: {
      types?: string[];
      not_types?: string[];
      senders?: string[];
      not_senders?: string[];
      limit?: number;
      lazy_load_members?: boolean;
      unread_thread_notifications?: boolean;
    };
    state?: {
      types?: string[];
      not_types?: string[];
      senders?: string[];
      not_senders?: string[];
      limit?: number;
      lazy_load_members?: boolean;
    };
    ephemeral?: {
      types?: string[];
      not_types?: string[];
      senders?: string[];
      not_senders?: string[];
      limit?: number;
    };
    account_data?: {
      types?: string[];
      not_types?: string[];
      senders?: string[];
      not_senders?: string[];
      limit?: number;
    };
    include_leave?: boolean;
  };
  presence?: {
    types?: string[];
    not_types?: string[];
    senders?: string[];
    not_senders?: string[];
    limit?: number;
  };
  account_data?: {
    types?: string[];
    not_types?: string[];
    senders?: string[];
    not_senders?: string[];
    limit?: number;
  };
  event_format?: "client" | "federation";
  event_fields?: string[];
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
    userId: string,
    roomId: string,
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
}

export interface SyncRepository {
  loadFilter(userId: string, filterParam?: string): Promise<FilterDefinition | null>;
  getLatestStreamPosition(): Promise<number>;
  getLatestDeviceKeyPosition(): Promise<number>;
  getToDeviceMessages(
    userId: string,
    deviceId: string,
    since: string,
  ): Promise<{ events: ToDeviceEvent[]; nextBatch: string }>;
  getOneTimeKeyCounts(userId: string, deviceId: string): Promise<Record<string, number>>;
  getUnusedFallbackKeyTypes(userId: string, deviceId: string): Promise<string[]>;
  getDeviceListChanges(
    userId: string,
    sinceEventPosition: number,
    sinceDeviceKeyPosition: number,
  ): Promise<{ changed: string[]; left: string[] }>;
  getGlobalAccountData(userId: string, since?: number): Promise<AccountDataEvent[]>;
  getRoomAccountData(userId: string, roomId: string, since?: number): Promise<AccountDataEvent[]>;
  getUserRooms(userId: UserId, membership?: Membership): Promise<RoomId[]>;
  getMembership(roomId: RoomId, userId: UserId): Promise<MembershipRecord | null>;
  getEventsSince(roomId: RoomId, sincePosition: number): Promise<PDU[]>;
  getEvent(eventId: EventId): Promise<PDU | null>;
  getRoomState(roomId: RoomId): Promise<PDU[]>;
  getInviteStrippedState(roomId: RoomId): Promise<StrippedStateEvent[]>;
  getReceiptsForRoom(roomId: RoomId, userId: UserId): Promise<ReceiptEvent>;
  getUnreadNotificationSummary(roomId: RoomId, userId: UserId): Promise<UnreadNotificationSummary>;
  getTypingUsers(roomId: RoomId): Promise<string[]>;
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
  getProcessedPdu(eventId: string): Promise<FederationProcessedPdu | null>;
  recordProcessedPdu(
    eventId: string,
    origin: string,
    roomId: string,
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
    userId: string,
    presence: string,
    statusMessage: string | null,
    lastActiveTs: number,
    currentlyActive: boolean,
  ): Promise<void>;
  upsertRemoteDeviceList(
    userId: string,
    deviceId: string,
    streamId: number,
    keys: Record<string, unknown> | null,
    displayName?: string,
    deleted?: boolean,
  ): Promise<void>;
}
