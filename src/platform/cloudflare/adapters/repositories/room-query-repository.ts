import {
  getMembership,
  getRoomEvents,
  getRoomMembers,
  getRoomState,
  getStateEvent,
} from "../db/database";
import type {
  EventId,
  EventType,
  Membership,
  PDU,
  RoomId,
  StateKey,
  UserId,
} from "../../../../fatrix-model/types";
import type { RoomMessagesRelationFilter } from "../../../../fatrix-model/types/rooms";
import { toEventId, toUserId } from "../../../../fatrix-model/utils/ids";

export async function getRoomMembershipForQuery(
  db: D1Database,
  roomId: RoomId,
  userId: UserId,
): Promise<{ membership: Membership; eventId: EventId } | null> {
  const membership = await getMembership(db, roomId, userId);
  const eventId = membership ? toEventId(membership.eventId) : null;
  return membership && eventId
    ? {
        membership: membership.membership,
        eventId,
      }
    : null;
}

export function getRoomStateForQuery(db: D1Database, roomId: RoomId): Promise<PDU[]> {
  return getRoomState(db, roomId);
}

export function getRoomStateEventForQuery(
  db: D1Database,
  roomId: RoomId,
  eventType: EventType,
  stateKey: StateKey,
): Promise<PDU | null> {
  return getStateEvent(db, roomId, eventType, stateKey);
}

export async function getRoomMembersForQuery(
  db: D1Database,
  roomId: RoomId,
  membership?: Membership,
): Promise<
  Array<{
    userId: UserId;
    membership: Membership;
    displayName?: string;
    avatarUrl?: string;
  }>
> {
  return (await getRoomMembers(db, roomId, membership)).flatMap((member) => {
    const userId = toUserId(member.userId);
    return userId
      ? [
          {
            userId,
            membership: member.membership,
            ...(member.displayName !== undefined ? { displayName: member.displayName } : {}),
            ...(member.avatarUrl !== undefined ? { avatarUrl: member.avatarUrl } : {}),
          },
        ]
      : [];
  });
}

export function getRoomEventsForQuery(
  db: D1Database,
  roomId: RoomId,
  fromToken: number | undefined,
  limit: number,
  direction: "f" | "b",
  relationFilter?: RoomMessagesRelationFilter,
): Promise<{ events: PDU[]; end: number }> {
  return getRoomEvents(db, roomId, fromToken, limit, direction, relationFilter);
}
