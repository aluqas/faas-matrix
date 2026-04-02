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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function toRawFederationPdu(input: Record<string, unknown>): RawFederationPdu {
  return {
    ...input,
    ...(typeof input["event_id"] === "string" ? { event_id: input["event_id"] } : {}),
    ...(typeof input["room_id"] === "string" ? { room_id: input["room_id"] } : {}),
    ...(typeof input["sender"] === "string" ? { sender: input["sender"] } : {}),
    ...(typeof input["type"] === "string" ? { type: input["type"] } : {}),
    ...(typeof input["state_key"] === "string" ? { state_key: input["state_key"] } : {}),
    ...(isRecord(input["content"]) ? { content: input["content"] } : {}),
  };
}

export function extractRawFederationPduFields(pdu: RawFederationPdu): RawFederationPduFields {
  return {
    ...(typeof pdu.room_id === "string" ? { roomId: pdu.room_id } : {}),
    ...(typeof pdu.sender === "string" ? { sender: pdu.sender } : {}),
    ...(typeof pdu.type === "string" ? { eventType: pdu.type } : {}),
    ...(typeof pdu.event_id === "string" ? { eventId: pdu.event_id } : {}),
    ...(typeof pdu.state_key === "string" ? { stateKey: pdu.state_key } : {}),
    ...(pdu.content ? { content: pdu.content } : {}),
  };
}

export function toRawFederationEdu(input: Record<string, unknown>): RawFederationEdu {
  return {
    ...input,
    ...(typeof input["edu_type"] === "string" ? { edu_type: input["edu_type"] } : {}),
    ...(isRecord(input["content"]) ? { content: input["content"] } : {}),
  };
}

export function getRoomScopedEduRoomIds(
  eduType: string,
  content: Record<string, unknown>,
): string[] {
  if (eduType === "m.typing") {
    return typeof content["room_id"] === "string" ? [content["room_id"]] : [];
  }

  if (eduType === "m.receipt") {
    return Object.keys(content);
  }

  return [];
}
