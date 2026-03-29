import type { Membership, PDU, Room } from "../../types";

export interface MembershipRecord {
  membership: Membership;
  eventId: string;
}

export interface ReceiptEvent {
  type: string;
  content: Record<string, unknown>;
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
    };
    state?: {
      types?: string[];
      not_types?: string[];
      senders?: string[];
      not_senders?: string[];
      limit?: number;
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
  getMembership(roomId: string, userId: string): Promise<MembershipRecord | null>;
  getStateEvent(roomId: string, eventType: string, stateKey?: string): Promise<PDU | null>;
  getLatestRoomEvents(roomId: string, limit: number): Promise<PDU[]>;
}

export interface SyncRepository {
  loadFilter(userId: string, filterParam?: string): Promise<FilterDefinition | null>;
  getLatestStreamPosition(): Promise<number>;
  getToDeviceMessages(
    userId: string,
    deviceId: string,
    since: string,
  ): Promise<{ events: unknown[]; nextBatch: string }>;
  getOneTimeKeyCounts(userId: string, deviceId: string): Promise<Record<string, number>>;
  getUnusedFallbackKeyTypes(userId: string, deviceId: string): Promise<string[]>;
  getDeviceListChanges(
    userId: string,
    sincePosition: number,
  ): Promise<{ changed: string[]; left: string[] }>;
  getGlobalAccountData(userId: string, since?: number): Promise<any[]>;
  getRoomAccountData(userId: string, roomId: string, since?: number): Promise<any[]>;
  getUserRooms(userId: string, membership?: Membership): Promise<string[]>;
  getMembership(roomId: string, userId: string): Promise<MembershipRecord | null>;
  getEventsSince(roomId: string, sincePosition: number): Promise<PDU[]>;
  getEvent(eventId: string): Promise<PDU | null>;
  getRoomState(roomId: string): Promise<PDU[]>;
  getInviteStrippedState(
    roomId: string,
  ): Promise<{ type: string; state_key: string; content: any; sender: string }[]>;
  getReceiptsForRoom(roomId: string, userId: string): Promise<ReceiptEvent>;
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
  getRoomState(roomId: string): Promise<PDU[]>;
  getInviteStrippedState(
    roomId: string,
  ): Promise<{ type: string; state_key: string; content: any; sender: string }[]>;
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
