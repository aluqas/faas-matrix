import type { Membership, PDU, UnsignedData } from "./matrix";
import type { PartialStateStatus } from "./partial-state";
import type { TimestampDirection } from "./events";

export type RoomEventResponse = {
  type: string;
  state_key?: string;
  content: Record<string, unknown>;
  sender: string;
  origin_server_ts: number;
  event_id: string;
  room_id: string;
  unsigned?: UnsignedData;
};

export interface RoomMessagesRelationFilter {
  relTypes?: string[];
  notRelTypes?: string[];
}

export interface GetRoomStateInput {
  userId: string;
  roomId: string;
}

export interface GetRoomStateEventInput {
  userId: string;
  roomId: string;
  eventType: string;
  stateKey: string;
  formatEvent?: boolean;
}

export interface GetRoomMembersInput {
  userId: string;
  roomId: string;
}

export interface GetRoomMessagesInput {
  userId: string;
  roomId: string;
  from?: string;
  dir: "f" | "b";
  limit: number;
  relationFilter?: RoomMessagesRelationFilter;
}

export interface GetVisibleRoomEventInput {
  userId: string;
  roomId: string;
  eventId: string;
}

export interface TimestampToEventInput {
  userId: string;
  roomId: string;
  ts: number;
  dir: TimestampDirection;
}

export interface RoomQueryDependencies {
  getMembership(
    db: D1Database,
    roomId: string,
    userId: string,
  ): Promise<{ membership: Membership; eventId: string } | null>;
  getRoomState(db: D1Database, roomId: string): Promise<PDU[]>;
  getStateEvent(
    db: D1Database,
    roomId: string,
    eventType: string,
    stateKey: string,
  ): Promise<PDU | null>;
  getRoomMembers(
    db: D1Database,
    roomId: string,
  ): Promise<
    Array<{
      userId: string;
      membership: Membership;
      displayName?: string;
      avatarUrl?: string;
    }>
  >;
  getRoomEvents(
    db: D1Database,
    roomId: string,
    fromToken: number | undefined,
    limit: number,
    direction: "f" | "b",
    relationFilter?: RoomMessagesRelationFilter,
  ): Promise<{ events: PDU[]; end: number }>;
  getVisibleEventForUser(
    db: D1Database,
    roomId: string,
    eventId: string,
    userId: string,
  ): Promise<PDU | null>;
  findClosestEventByTimestamp(
    db: D1Database,
    roomId: string,
    ts: number,
    dir: TimestampDirection,
  ): Promise<{ event_id: string; origin_server_ts: number } | null>;
  getPartialStateJoin(
    cache: KVNamespace | undefined,
    userId: string,
    roomId: string,
  ): Promise<PartialStateStatus | null>;
  getPartialStateJoinCompletion(
    cache: KVNamespace | undefined,
    userId: string,
    roomId: string,
  ): Promise<PartialStateStatus | null>;
  sleep(ms: number): Promise<void>;
}

export interface CreateRoomInput {
  userId: string;
  body: unknown;
}

export interface JoinRoomInput {
  userId: string;
  roomId: string;
  remoteServers?: string[];
  body?: unknown;
}

export interface SendEventInput {
  userId: string;
  roomId: string;
  eventType: string;
  stateKey?: string;
  txnId: string;
  content: Record<string, unknown>;
  redacts?: string;
}

export interface LeaveRoomInput {
  userId: string;
  roomId: string;
}

export interface InviteRoomInput {
  userId: string;
  roomId: string;
  targetUserId: string;
}

export interface ModerateRoomInput {
  userId: string;
  roomId: string;
  targetUserId: string;
  reason?: string;
}

export interface KnockRoomInput {
  userId: string;
  roomId: string;
  reason?: string;
  serverNames?: string[];
}
