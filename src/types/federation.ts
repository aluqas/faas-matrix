export interface RawFederationPdu extends Record<string, unknown> {
  event_id?: string;
  room_id?: string;
  sender?: string;
  type?: string;
  state_key?: string;
  content?: Record<string, unknown>;
}

export interface RawFederationEdu extends Record<string, unknown> {
  edu_type?: string;
  content?: Record<string, unknown>;
}

export interface RawFederationPduFields {
  roomId?: string;
  sender?: string;
  eventType?: string;
  eventId?: string;
  stateKey?: string;
  content?: Record<string, unknown>;
}

export interface FederationTransactionEnvelope {
  origin: string;
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
  softFailedEventIds: string[];
}

export interface PduIngestInput {
  origin: string;
  txnId: string;
  rawPdu: Record<string, unknown>;
  disableGapFill?: boolean;
  historicalOnly?: boolean;
}

export interface PduIngestResult {
  kind: "accepted" | "rejected" | "soft_failed" | "ignored";
  eventId: string;
  reason?: string;
  requiresRefanout: boolean;
}

export interface RoomScopedEduInput {
  eduType: string;
  roomId: string;
  origin: string;
  senderServer?: string;
  content: Record<string, unknown>;
}

export interface EduIngestInput {
  origin: string;
  rawEdu: Record<string, unknown>;
}

export interface EduIngestResult {
  kind: "applied" | "rejected" | "ignored";
  eduType: string;
  roomIds: string[];
  reason?: string;
}

export interface FederationProfileQueryInput {
  userId: string;
  field?: string;
}

export interface FederationRelationshipsQueryInput {
  eventId: string;
  roomId?: string;
  direction: "up" | "down";
  includeParent?: boolean;
  recentFirst?: boolean;
  maxDepth?: number;
}

export type FederationQueryInput =
  | ({ kind: "profile" } & FederationProfileQueryInput)
  | ({ kind: "event_relationships" } & FederationRelationshipsQueryInput);

export type FederationEventRow = {
  event_id: string;
  room_id: string;
  sender: string;
  event_type: string;
  state_key: string | null;
  content: string;
  origin_server_ts: number;
  depth: number;
  auth_events: string;
  prev_events: string;
  event_origin?: string | null;
  event_membership?: string | null;
  prev_state?: string | null;
  hashes?: string | null;
  signatures?: string | null;
};
