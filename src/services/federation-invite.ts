import { ErrorCodes, type PDU } from "../types";
import { MatrixApiError } from "../utils/errors";
import { federationPut } from "./federation-keys";
import { getRoom, getRoomState } from "./database";

type StrippedStateEvent = {
  type: string;
  sender: string;
  content: Record<string, unknown>;
  state_key?: string;
  room_id?: string;
  event_id?: string;
  origin_server_ts?: number;
};

function getUserServerName(userId: string): string | null {
  const colonIndex = userId.indexOf(":");
  if (colonIndex < 0 || colonIndex === userId.length - 1) {
    return null;
  }
  return userId.slice(colonIndex + 1);
}

function toInviteRoomState(events: PDU[]): StrippedStateEvent[] {
  return events
    .filter((event) => event.state_key !== undefined)
    .map((event) => ({
      type: event.type,
      sender: event.sender,
      state_key: event.state_key,
      content: event.content,
      room_id: event.room_id,
      event_id: event.event_id,
      origin_server_ts: event.origin_server_ts,
    }));
}

export async function sendFederationInvite(
  db: D1Database,
  cache: KVNamespace,
  localServerName: string,
  roomId: string,
  inviteEvent: PDU,
): Promise<void> {
  if (
    inviteEvent.type !== "m.room.member" ||
    inviteEvent.content.membership !== "invite" ||
    !inviteEvent.state_key
  ) {
    return;
  }

  const remoteServer = getUserServerName(inviteEvent.state_key);
  if (!remoteServer || remoteServer === localServerName) {
    return;
  }

  const room = await getRoom(db, roomId);
  if (!room) {
    return;
  }

  const roomState = await getRoomState(db, roomId);
  const inviteRoomState = toInviteRoomState(roomState);

  const response = await federationPut(
    remoteServer,
    `/_matrix/federation/v2/invite/${encodeURIComponent(roomId)}/${encodeURIComponent(inviteEvent.event_id)}`,
    {
      room_version: room.room_version,
      event: inviteEvent,
      invite_room_state: inviteRoomState,
    },
    localServerName,
    db,
    cache,
  );

  if (response.ok) {
    return;
  }

  let errcode: string | undefined;
  let message = `Remote server rejected invite with HTTP ${response.status}`;
  try {
    const body = await response.json();
    if (typeof body.errcode === "string") {
      errcode = body.errcode;
    }
    if (typeof body.error === "string") {
      message = body.error;
    }
  } catch {
    // Ignore malformed bodies and fall back to the HTTP status.
  }

  if (response.status === 403 && errcode === ErrorCodes.M_INVITE_BLOCKED) {
    throw new MatrixApiError(ErrorCodes.M_INVITE_BLOCKED, message, 403);
  }

  throw new MatrixApiError(
    (errcode as (typeof ErrorCodes)[keyof typeof ErrorCodes] | undefined) ?? ErrorCodes.M_UNKNOWN,
    message,
    response.status || 500,
  );
}
