import type { Membership, RoomId, UserId } from "../../../../fatrix-model/types";
import { Errors } from "../../../../fatrix-model/utils/errors";
import { runFederationEffect } from "../../runtime/effect-runtime";
import {
  authorizeLocalKnock,
  type JoinRulesContent,
} from "../../room-membership-policy";
import {
  getFederationLatestEvent,
  getFederationMembershipRecord,
  getFederationRoomRecord,
  getFederationStateEventId,
  getFederationStateEventRef,
} from "../../../../platform/cloudflare/adapters/repositories/federation-membership-read-repository";

export async function buildFederationMakeKnockTemplate(input: {
  db: D1Database;
  roomId: RoomId;
  userId: UserId;
}): Promise<{ roomVersion: string; event: Record<string, unknown> } | Response> {
  const room = await getFederationRoomRecord(input.db, input.roomId);
  if (!room) {
    return Errors.notFound("Room not found").toResponse();
  }

  const [joinRulesRow, membership, createEventId, powerLevelsEventId, latestEvent] =
    await Promise.all([
      getFederationStateEventRef(input.db, input.roomId, "m.room.join_rules"),
      getFederationMembershipRecord(input.db, input.roomId, input.userId),
      getFederationStateEventId(input.db, input.roomId, "m.room.create"),
      getFederationStateEventId(input.db, input.roomId, "m.room.power_levels"),
      getFederationLatestEvent(input.db, input.roomId),
    ]);

  try {
    await runFederationEffect(
      authorizeLocalKnock({
        roomVersion: room.roomVersion,
        joinRule: joinRulesRow
          ? (JSON.parse(joinRulesRow.content) as JoinRulesContent).join_rule
          : undefined,
        currentMembership: membership?.membership as Membership | undefined,
      }),
    );
  } catch {
    return Errors.forbidden("Knock event not allowed").toResponse();
  }

  const authEvents: string[] = [];
  for (const candidate of [createEventId, joinRulesRow?.eventId, powerLevelsEventId]) {
    if (candidate) {
      authEvents.push(candidate);
    }
  }

  const prevEvents = latestEvent ? [latestEvent.eventId] : [];
  const depth = (latestEvent?.depth ?? 0) + 1;

  return {
    roomVersion: room.roomVersion,
    event: {
      room_id: input.roomId,
      sender: input.userId,
      type: "m.room.member",
      state_key: input.userId,
      content: { membership: "knock" },
      origin_server_ts: Date.now(),
      depth,
      auth_events: authEvents,
      prev_events: prevEvents,
    },
  };
}
