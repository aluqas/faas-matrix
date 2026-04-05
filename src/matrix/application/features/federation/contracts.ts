import type {
  EduIngestInput,
  EduIngestResult,
  FederationProfileQueryInput,
  FederationQueryInput,
  FederationRelationshipsQueryInput,
  FederationTransactionEnvelope,
  FederationTransactionResult,
  PduIngestInput,
  PduIngestResult,
  RawFederationEdu,
  RawFederationPdu,
  RawFederationPduFields,
  RoomScopedEduInput,
} from "../../../../types/federation";

export type {
  EduIngestInput,
  EduIngestResult,
  FederationProfileQueryInput,
  FederationQueryInput,
  FederationRelationshipsQueryInput,
  FederationTransactionEnvelope,
  FederationTransactionResult,
  PduIngestInput,
  PduIngestResult,
  RawFederationEdu,
  RawFederationPdu,
  RawFederationPduFields,
  RoomScopedEduInput,
};

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
