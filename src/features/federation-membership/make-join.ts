import { Effect } from "effect";
import type { Membership, RoomId, UserId } from "../../shared/types";
import { Errors } from "../../shared/utils/errors";
import { runFederationEffect } from "../../matrix/application/runtime/effect-runtime";
import {
  authorizeLocalJoin,
  type JoinRulesContent,
} from "../../matrix/application/room-membership-policy";
import {
  getFederationCurrentStateMembership,
  getFederationLatestEvent,
  getFederationMembershipRecord,
  getFederationRoomRecord,
  getFederationStateEventId,
  getFederationStateEventRef,
  isUserJoinedToAllowedRoom,
} from "../../infra/repositories/federation-membership-read-repository";

export async function buildFederationMakeJoinTemplate(input: {
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
        content: { membership: "join" };
        origin_server_ts: number;
        depth: number;
        auth_events: string[];
        prev_events: string[];
      };
      currentMembership: string | undefined;
      currentMembershipEventId: string | undefined;
      currentStateMembership: string | null | undefined;
      currentStateMembershipEventId: string | undefined;
    }
  | Response
> {
  const room = await getFederationRoomRecord(input.db, input.roomId);
  if (!room) {
    return Errors.notFound("Room not found").toResponse();
  }

  const [
    createEventId,
    joinRulesEvent,
    powerLevelsEventId,
    currentMembership,
    currentStateMembership,
  ] = await Promise.all([
    getFederationStateEventId(input.db, input.roomId, "m.room.create"),
    getFederationStateEventRef(input.db, input.roomId, "m.room.join_rules"),
    getFederationStateEventId(input.db, input.roomId, "m.room.power_levels"),
    getFederationMembershipRecord(input.db, input.roomId, input.userId),
    getFederationCurrentStateMembership(input.db, input.roomId, input.userId),
  ]);

  const joinRulesContent = joinRulesEvent
    ? (JSON.parse(joinRulesEvent.content) as JoinRulesContent)
    : null;

  try {
    await runFederationEffect(
      authorizeLocalJoin({
        roomVersion: String(room.roomVersion),
        joinRulesContent,
        currentMembership: currentMembership?.membership as Membership | undefined,
        checkAllowedRoomMembership: (allowedRoomId) =>
          Effect.promise(() => isUserJoinedToAllowedRoom(input.db, allowedRoomId, input.userId)),
      }),
    );
  } catch (error) {
    return error instanceof Error && "toResponse" in error
      ? (error as { toResponse: () => Response }).toResponse()
      : Errors.forbidden("Join event not allowed").toResponse();
  }

  const authEvents: string[] = [];
  if (createEventId) authEvents.push(createEventId);
  if (joinRulesEvent) authEvents.push(joinRulesEvent.eventId);
  if (powerLevelsEventId) authEvents.push(powerLevelsEventId);
  if (currentMembership?.eventId) authEvents.push(currentMembership.eventId);

  const latestEvent = await getFederationLatestEvent(input.db, input.roomId);
  const prevEvents = latestEvent ? [latestEvent.eventId] : [];
  const depth = (latestEvent?.depth ?? 0) + 1;

  return {
    roomVersion: room.roomVersion,
    event: {
      room_id: input.roomId,
      sender: input.userId,
      type: "m.room.member",
      state_key: input.userId,
      content: { membership: "join" },
      origin_server_ts: Date.now(),
      depth,
      auth_events: authEvents,
      prev_events: prevEvents,
    },
    currentMembership: currentMembership?.membership,
    currentMembershipEventId: currentMembership?.eventId,
    currentStateMembership: currentStateMembership?.membership,
    currentStateMembershipEventId: currentStateMembership?.eventId,
  };
}
