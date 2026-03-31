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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function toRawFederationPdu(input: Record<string, unknown>): RawFederationPdu {
  return {
    ...input,
    event_id: typeof input["event_id"] === "string" ? input["event_id"] : undefined,
    room_id: typeof input["room_id"] === "string" ? input["room_id"] : undefined,
    sender: typeof input["sender"] === "string" ? input["sender"] : undefined,
    type: typeof input["type"] === "string" ? input["type"] : undefined,
    state_key: typeof input["state_key"] === "string" ? input["state_key"] : undefined,
    content: isRecord(input["content"]) ? input["content"] : undefined,
  };
}

export function extractRawFederationPduFields(pdu: RawFederationPdu): RawFederationPduFields {
  return {
    roomId: pdu.room_id,
    sender: pdu.sender,
    eventType: pdu.type,
    eventId: pdu.event_id,
    stateKey: pdu.state_key,
    content: pdu.content,
  };
}

export function toRawFederationEdu(input: Record<string, unknown>): RawFederationEdu {
  return {
    ...input,
    edu_type: typeof input["edu_type"] === "string" ? input["edu_type"] : undefined,
    content: isRecord(input["content"]) ? input["content"] : undefined,
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
