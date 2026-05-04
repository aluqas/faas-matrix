import type { RoomId, UserId } from "../../../../fatrix-model/types";
import { Errors } from "../../../../fatrix-model/utils/errors";
import {
  getFederationCurrentStateMembership,
  getFederationLatestEvent,
  getFederationMembershipRecord,
  getFederationRoomRecord,
  getFederationStateEventId,
} from "../../../../platform/cloudflare/adapters/repositories/federation-membership-read-repository";

export async function buildFederationMakeLeaveTemplate(input: {
  db: D1Database;
  roomId: RoomId;
  userId: UserId;
}): Promise<
  | {
      roomVersion: string;
      event: {
        room_id: RoomId;
        sender: UserId;
        type: "m.room.member";
        state_key: UserId;
        content: { membership: "leave" };
        origin_server_ts: number;
        depth: number;
        auth_events: string[];
        prev_events: string[];
      };
      currentMembership: string;
      currentMembershipEventId: string;
      currentStateMembership: string | null | undefined;
      currentStateMembershipEventId: string | undefined;
    }
  | Response
> {
  const room = await getFederationRoomRecord(input.db, input.roomId);
  if (!room) {
    return Errors.notFound("Room not found").toResponse();
  }

  const [membership, currentStateMembership, createEventId, powerLevelsEventId, latestEvent] =
    await Promise.all([
      getFederationMembershipRecord(input.db, input.roomId, input.userId),
      getFederationCurrentStateMembership(input.db, input.roomId, input.userId),
      getFederationStateEventId(input.db, input.roomId, "m.room.create"),
      getFederationStateEventId(input.db, input.roomId, "m.room.power_levels"),
      getFederationLatestEvent(input.db, input.roomId),
    ]);

  if (!membership || !["join", "invite", "knock"].includes(membership.membership)) {
    return new Response(
      JSON.stringify({
        errcode: "M_FORBIDDEN",
        error: "User is not joined, invited, or knocking in the room",
      }),
      { status: 403, headers: { "content-type": "application/json" } },
    );
  }

  const authEvents: string[] = [];
  if (createEventId) authEvents.push(createEventId);
  if (powerLevelsEventId) authEvents.push(powerLevelsEventId);
  authEvents.push(membership.eventId);

  const prevEvents = latestEvent ? [latestEvent.eventId] : [];
  const depth = (latestEvent?.depth ?? 0) + 1;

  return {
    roomVersion: room.roomVersion,
    event: {
      room_id: input.roomId,
      sender: input.userId,
      type: "m.room.member",
      state_key: input.userId,
      content: { membership: "leave" },
      origin_server_ts: Date.now(),
      depth,
      auth_events: authEvents,
      prev_events: prevEvents,
    },
    currentMembership: membership.membership,
    currentMembershipEventId: membership.eventId,
    currentStateMembership: currentStateMembership?.membership,
    currentStateMembershipEventId: currentStateMembership?.eventId,
  };
}
