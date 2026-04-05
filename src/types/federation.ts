import type {
  EventId,
  EventType,
  RoomId,
  RoomVersionId,
  ServerName,
  StateKey,
  UserId,
} from "./matrix";

export interface RawFederationPdu extends Record<string, unknown> {
  event_id?: EventId;
  room_id?: RoomId;
  sender?: UserId;
  type?: EventType;
  state_key?: StateKey;
  content?: Record<string, unknown>;
}

export interface RawFederationEdu extends Record<string, unknown> {
  edu_type?: string;
  content?: Record<string, unknown>;
}

export interface RawFederationPduFields {
  roomId?: RoomId;
  sender?: UserId;
  eventType?: EventType;
  eventId?: EventId;
  stateKey?: StateKey;
  content?: Record<string, unknown>;
}

export interface FederationTransactionEnvelope {
  origin: ServerName;
  txnId: string;
  body: {
    pdus?: Array<Record<string, unknown>>;
    edus?: Array<Record<string, unknown>>;
  };
  disableGapFill?: boolean;
  historicalOnly?: boolean;
}

export interface FederationTransactionResult {
  pdus: Record<string, unknown>;
  acceptedPduCount: number;
  rejectedPduCount: number;
  processedEduCount: number;
  softFailedEventIds: EventId[];
}

export interface PduIngestInput {
  origin: ServerName;
  txnId: string;
  rawPdu: Record<string, unknown>;
  disableGapFill?: boolean;
  historicalOnly?: boolean;
}

export interface PduIngestResult {
  kind: "accepted" | "rejected" | "soft_failed" | "ignored";
  eventId: EventId;
  reason?: string;
  requiresRefanout: boolean;
}

export interface RoomScopedEduInput {
  eduType: string;
  roomId: RoomId;
  origin: ServerName;
  senderServer?: ServerName;
  content: Record<string, unknown>;
}

export interface EduIngestInput {
  origin: ServerName;
  rawEdu: Record<string, unknown>;
}

export interface EduIngestResult {
  kind: "applied" | "rejected" | "ignored";
  eduType: string;
  roomIds: RoomId[];
  reason?: string;
}

export interface FederationProfileQueryInput {
  userId: UserId;
  field?: string;
}

export interface FederationRelationshipsQueryInput {
  eventId: EventId;
  roomId?: RoomId;
  direction: "up" | "down";
  includeParent?: boolean;
  recentFirst?: boolean;
  maxDepth?: number;
}

export type FederationQueryInput =
  | ({ kind: "profile" } & FederationProfileQueryInput)
  | ({ kind: "event_relationships" } & FederationRelationshipsQueryInput);

export type FederationEventRow = {
  event_id: EventId;
  room_id: RoomId;
  sender: UserId;
  event_type: EventType;
  state_key: StateKey | null;
  content: string;
  origin_server_ts: number;
  depth: number;
  auth_events: string;
  prev_events: string;
  event_origin?: ServerName | null;
  event_membership?: string | null;
  prev_state?: string | null;
  hashes?: string | null;
  signatures?: string | null;
};
