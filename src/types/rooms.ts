import type {
  EventId,
  EventType,
  Membership,
  PDU,
  RoomId,
  ServerName,
  StateKey,
  UnsignedData,
  UserId,
} from "./matrix";
import type { PartialStateStatus } from "./partial-state";
import type { EventWithIdResponse, TimestampDirection } from "./events";

export type RoomEventResponse = EventWithIdResponse & {
  state_key?: StateKey;
  room_id: RoomId;
  unsigned?: UnsignedData;
};

export interface RoomMessagesRelationFilter {
  relTypes?: string[];
  notRelTypes?: string[];
}

export interface GetRoomStateInput {
  userId: UserId;
  roomId: RoomId;
}

export interface GetRoomStateEventInput {
  userId: UserId;
  roomId: RoomId;
  eventType: EventType;
  stateKey: StateKey;
  formatEvent?: boolean;
}

export interface GetRoomMembersInput {
  userId: UserId;
  roomId: RoomId;
}

export interface GetRoomMessagesInput {
  userId: UserId;
  roomId: RoomId;
  from?: string;
  dir: "f" | "b";
  limit: number;
  relationFilter?: RoomMessagesRelationFilter;
}

export interface GetVisibleRoomEventInput {
  userId: UserId;
  roomId: RoomId;
  eventId: EventId;
}

export interface TimestampToEventInput {
  userId: UserId;
  roomId: RoomId;
  ts: number;
  dir: TimestampDirection;
}

export interface RoomQueryDependencies {
  getMembership(
    db: D1Database,
    roomId: RoomId,
    userId: UserId,
  ): Promise<{ membership: Membership; eventId: EventId } | null>;
  getRoomState(db: D1Database, roomId: RoomId): Promise<PDU[]>;
  getStateEvent(
    db: D1Database,
    roomId: RoomId,
    eventType: EventType,
    stateKey: StateKey,
  ): Promise<PDU | null>;
  getRoomMembers(
    db: D1Database,
    roomId: RoomId,
  ): Promise<
    Array<{
      userId: UserId;
      membership: Membership;
      displayName?: string;
      avatarUrl?: string;
    }>
  >;
  getRoomEvents(
    db: D1Database,
    roomId: RoomId,
    fromToken: number | undefined,
    limit: number,
    direction: "f" | "b",
    relationFilter?: RoomMessagesRelationFilter,
  ): Promise<{ events: PDU[]; end: number }>;
  getVisibleEventForUser(
    db: D1Database,
    roomId: RoomId,
    eventId: EventId,
    userId: UserId,
  ): Promise<PDU | null>;
  findClosestEventByTimestamp(
    db: D1Database,
    roomId: RoomId,
    ts: number,
    dir: TimestampDirection,
  ): Promise<{ event_id: EventId; origin_server_ts: number } | null>;
  getPartialStateJoin(
    cache: KVNamespace | undefined,
    userId: UserId,
    roomId: RoomId,
  ): Promise<PartialStateStatus | null>;
  getPartialStateJoinCompletion(
    cache: KVNamespace | undefined,
    userId: UserId,
    roomId: RoomId,
  ): Promise<PartialStateStatus | null>;
  sleep(ms: number): Promise<void>;
}

export interface CreateRoomInput {
  userId: UserId;
  body: unknown;
}

export interface JoinRoomInput {
  userId: UserId;
  roomId: RoomId;
  remoteServers?: ServerName[];
  body?: unknown;
}

export interface SendEventInput {
  userId: UserId;
  roomId: RoomId;
  eventType: EventType;
  stateKey?: StateKey;
  txnId: string;
  content: Record<string, unknown>;
  redacts?: EventId;
}

export interface LeaveRoomInput {
  userId: UserId;
  roomId: RoomId;
}

export interface InviteRoomInput {
  userId: UserId;
  roomId: RoomId;
  targetUserId: UserId;
}

export interface ModerateRoomInput {
  userId: UserId;
  roomId: RoomId;
  targetUserId: UserId;
  reason?: string;
}

export interface KnockRoomInput {
  userId: UserId;
  roomId: RoomId;
  reason?: string;
  serverNames?: ServerName[];
}
