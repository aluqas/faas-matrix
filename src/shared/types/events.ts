import type {
  EventId,
  EventType,
  Membership,
  RoomId,
  RoomVersionId,
  ServerName,
  StateKey,
  UserId,
} from "./matrix";

export interface EventResponseBase {
  type: EventType;
  sender: UserId;
  origin_server_ts: number;
  content: Record<string, unknown>;
}

export interface EventWithIdResponse extends EventResponseBase {
  event_id: EventId;
}

export interface RelationEvent extends EventWithIdResponse {}

export interface EventRelationshipsRequest {
  eventId: EventId;
  roomId?: RoomId;
  direction: "up" | "down";
  includeParent?: boolean;
  recentFirst?: boolean;
  maxDepth?: number;
}

export interface EventRelationshipsResult {
  events: Array<Record<string, unknown>>;
  nextBatch?: string;
  limited?: boolean;
}

export type TimestampDirection = "f" | "b";

export type RelationCursor = {
  value: number;
  column: "origin_server_ts" | "stream_ordering";
};

export interface MissingEventsQuery {
  roomId: RoomId;
  earliestEvents: EventId[];
  latestEvents: EventId[];
  limit: number;
  minDepth: number;
  requestingServer?: ServerName;
  roomVersion?: RoomVersionId;
}

export type StoredEventRow = {
  event_id: EventId;
  room_id: RoomId;
  sender: UserId;
  event_type: EventType;
  state_key: StateKey | null;
  content: string;
  origin_server_ts: number;
};

export type StoredPduRow = StoredEventRow & {
  unsigned?: string | null;
  depth: number;
  auth_events: string;
  prev_events: string;
  event_origin?: ServerName | null;
  event_membership?: Membership | null;
  prev_state?: string | null;
  hashes?: string | null;
  signatures?: string | null;
  stream_ordering?: number;
};
