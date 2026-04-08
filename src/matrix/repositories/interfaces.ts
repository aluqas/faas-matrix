import type {
  AccountDataEvent,
  EphemeralEvent,
  Membership,
  PDU,
  Room,
  RoomId,
  StrippedStateEvent,
  ToDeviceEvent,
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
    roomId: string,
    roomVersion: string,
    creatorId: string,
    isPublic: boolean,
  ): Promise<void>;
  createRoomAlias(alias: string, roomId: string, creatorId: string): Promise<void>;
  upsertRoomAccountData(
    userId: string,
    roomId: string,
    eventType: string,
    content: Record<string, unknown>,
  ): Promise<void>;
  storeEvent(event: PDU): Promise<void>;
  persistMembershipEvent(
    roomId: string,
    event: PDU,
    source: "client" | "federation" | "workflow",
  ): Promise<void>;
  updateMembership(
    roomId: string,
    userId: string,
    membership: Membership,
    eventId: string,
    displayName?: string,
    avatarUrl?: string,
  ): Promise<void>;
  notifyUsersOfEvent(roomId: string, eventId: string, eventType: string): Promise<void>;
  getRoom(roomId: string): Promise<Room | null>;
  getEvent(eventId: string): Promise<PDU | null>;
  getMembership(roomId: string, userId: string): Promise<MembershipRecord | null>;
  getStateEvent(roomId: string, eventType: string, stateKey?: string): Promise<PDU | null>;
  getLatestRoomEvents(roomId: string, limit: number): Promise<PDU[]>;
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
  getUserRooms(userId: string, membership?: Membership): Promise<RoomId[]>;
  getMembership(roomId: string, userId: string): Promise<MembershipRecord | null>;
  getEventsSince(roomId: string, sincePosition: number): Promise<PDU[]>;
  getEvent(eventId: string): Promise<PDU | null>;
  getRoomState(roomId: string): Promise<PDU[]>;
  getInviteStrippedState(roomId: string): Promise<StrippedStateEvent[]>;
  getReceiptsForRoom(roomId: string, userId: string): Promise<ReceiptEvent>;
  getUnreadNotificationSummary(roomId: string, userId: string): Promise<UnreadNotificationSummary>;
  getTypingUsers(roomId: string): Promise<string[]>;
  waitForUserEvents(userId: string, timeoutMs: number): Promise<{ hasEvents: boolean }>;
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
    roomId: string,
    roomVersion: string,
    creatorId: string,
    isPublic: boolean,
  ): Promise<void>;
  getRoom(roomId: string): Promise<Room | null>;
  getEvent(eventId: string): Promise<PDU | null>;
  getLatestRoomEvents(roomId: string, limit: number): Promise<PDU[]>;
  getRoomState(roomId: string): Promise<PDU[]>;
  getInviteStrippedState(roomId: string): Promise<StrippedStateEvent[]>;
  storeIncomingEvent(event: PDU): Promise<void>;
  notifyUsersOfEvent(roomId: string, eventId: string, eventType: string): Promise<void>;
  updateMembership(
    roomId: string,
    userId: string,
    membership: "join" | "invite" | "leave" | "ban" | "knock",
    eventId: string,
    displayName?: string,
    avatarUrl?: string,
  ): Promise<void>;
  upsertRoomState(
    roomId: string,
    eventType: string,
    stateKey: string,
    eventId: string,
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
