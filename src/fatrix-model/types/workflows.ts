import type { ErrorCode, EventId, RoomId, ServerName, UserId } from "./matrix";
import type { JsonObject, JsonValue } from "./common";

export type { JsonObject, JsonValue };

export interface RoomJoinWorkflowParams {
  roomId: RoomId;
  userId: UserId;
  displayName?: string;
  avatarUrl?: string;
  isRemote: boolean;
  remoteServer?: ServerName;
  remoteServers?: ServerName[];
  reason?: string;
}

export interface RoomJoinWorkflowResult {
  eventId: EventId;
  roomId: RoomId;
  success: boolean;
  error?: string;
  errorStatus?: number;
  errorErrcode?: ErrorCode;
}

export interface RoomJoinWorkflowStatus {
  status?: string;
  output?: Partial<RoomJoinWorkflowResult>;
}

export interface RemoteJoinTemplateEvent {
  auth_events?: string[];
  prev_events?: string[];
  depth?: number;
  join_authorised_via_users_server?: string;
}

export interface RemoteJoinTemplate {
  room_version: string;
  event: RemoteJoinTemplateEvent;
}

export interface RemoteSendJoinResponse {
  state: JsonObject[];
  auth_chain: JsonObject[];
  members_omitted?: boolean;
  servers_in_room?: ServerName[];
  event?: JsonObject;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toJsonValue(value: unknown): JsonValue | undefined {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => toJsonValue(entry))
      .filter((entry): entry is JsonValue => entry !== undefined);
  }

  if (!isPlainObject(value)) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(value)
      .map(([key, entry]) => {
        const normalized = toJsonValue(entry);
        return normalized === undefined ? null : [key, normalized];
      })
      .filter((entry): entry is [string, JsonValue] => entry !== null),
  );
}

function toJsonObject(value: unknown): JsonObject | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const normalized = toJsonValue(value);
  return normalized !== null && typeof normalized === "object" && !Array.isArray(normalized)
    ? normalized
    : null;
}

export function toRemoteJoinTemplate(value: unknown): RemoteJoinTemplate | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const roomVersion = value["room_version"];
  const event = value["event"];
  if (typeof roomVersion !== "string" || !isPlainObject(event)) {
    return null;
  }

  const templateEvent: RemoteJoinTemplateEvent = {
    auth_events: Array.isArray(event["auth_events"])
      ? event["auth_events"].filter((entry): entry is string => typeof entry === "string")
      : [],
    prev_events: Array.isArray(event["prev_events"])
      ? event["prev_events"].filter((entry): entry is string => typeof entry === "string")
      : [],
  };

  if (typeof event["depth"] === "number") {
    templateEvent.depth = event["depth"];
  }
  const content = toJsonObject(event["content"]);
  if (typeof content?.["join_authorised_via_users_server"] === "string") {
    templateEvent.join_authorised_via_users_server = content["join_authorised_via_users_server"];
  }

  return {
    room_version: roomVersion,
    event: templateEvent,
  };
}

export function toRemoteSendJoinResponse(value: unknown): RemoteSendJoinResponse {
  if (Array.isArray(value)) {
    const [state, authChain] = value;
    return {
      state: Array.isArray(state) ? state : [],
      auth_chain: Array.isArray(authChain) ? authChain : [],
    };
  }

  if (!isPlainObject(value)) {
    return { state: [], auth_chain: [] };
  }

  return {
    state: Array.isArray(value["state"])
      ? value["state"]
          .map((entry) => toJsonObject(entry))
          .filter((entry): entry is JsonObject => entry !== null)
      : [],
    auth_chain: Array.isArray(value["auth_chain"])
      ? value["auth_chain"]
          .map((entry) => toJsonObject(entry))
          .filter((entry): entry is JsonObject => entry !== null)
      : [],
    ...(typeof value["members_omitted"] === "boolean"
      ? { members_omitted: value["members_omitted"] }
      : {}),
    ...(Array.isArray(value["servers_in_room"])
      ? {
          servers_in_room: value["servers_in_room"].filter(
            (entry): entry is string => typeof entry === "string",
          ),
        }
      : {}),
    ...(toJsonObject(value["event"]) ? { event: toJsonObject(value["event"])! } : {}),
  };
}
