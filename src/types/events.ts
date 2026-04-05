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

export interface MissingEventsQuery {
  roomId: string;
  earliestEvents: string[];
  latestEvents: string[];
  limit: number;
  minDepth: number;
  requestingServer?: string;
  roomVersion?: string;
}
