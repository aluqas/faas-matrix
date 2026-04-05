export interface EventRelationshipsRequest {
  eventId: string;
  roomId?: string;
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
  roomId: string;
  earliestEvents: string[];
  latestEvents: string[];
  limit: number;
  minDepth: number;
  requestingServer?: string;
  roomVersion?: string;
}

export type StoredContextEvent = {
  event_id: string;
  room_id: string;
  sender: string;
  event_type: string;
  state_key: string | null;
  content: string;
  origin_server_ts: number;
};
