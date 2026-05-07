import type { EventId, Membership, RoomId } from "../../../../fatrix-model/types";
import type { Env } from "../../../../platform/cloudflare/env";
import { Errors } from "../../../../fatrix-model/utils/errors";
import {
  fanoutEventToFederation,
  notifyUsersOfEvent,
} from "../../../../platform/cloudflare/adapters/db/database";
import { persistFederationMembershipEvent } from "../../orchestrators/federation-handler-service";
import { requiresFullCreateEventInStrippedState } from "../../features/rooms/policies/room-version-semantics";
import { authorizeLocalKnock, type JoinRulesContent } from "../../room-membership-policy";
import { runFederationEffect } from "../../runtime/effect-runtime";
import { runDomainValidation } from "../../domain-validation";
import { validateSendKnockRequest } from "../validation";
import { toUserId } from "../../../../fatrix-model/utils/ids";
import {
  getFederationFullCreateEvent,
  getFederationMembershipRecord,
  getFederationRoomRecord,
  getFederationStateEventRef,
  listFederationStrippedStateEvents,
} from "../../../../platform/cloudflare/adapters/repositories/federation-membership-read-repository";

export async function processFederationSendKnock(input: {
  env: Pick<Env, "DB">;
  roomId: RoomId;
  eventId: EventId;
  body: unknown;
  origin?: string;
  waitUntil: (promise: Promise<unknown>) => void;
  envBindings: Env;
}): Promise<Response> {
  const validatedKnock = await runDomainValidation(
    validateSendKnockRequest({ body: input.body, roomId: input.roomId, eventId: input.eventId }),
  );
  const room = await getFederationRoomRecord(input.env.DB, input.roomId);
  if (!room) {
    return Errors.notFound("Room not found").toResponse();
  }

  const userId = toUserId(validatedKnock.event.state_key);
  if (!userId) {
    return Errors.invalidParam("userId", "Invalid user ID").toResponse();
  }
  const [joinRulesEvent, membership] = await Promise.all([
    getFederationStateEventRef(input.env.DB, input.roomId, "m.room.join_rules"),
    getFederationMembershipRecord(input.env.DB, input.roomId, userId),
  ]);

  try {
    await runFederationEffect(
      authorizeLocalKnock({
        roomVersion: room.roomVersion,
        joinRule: joinRulesEvent
          ? (JSON.parse(joinRulesEvent.content) as JoinRulesContent).join_rule
          : undefined,
        currentMembership: membership?.membership as Membership | undefined,
      }),
    );
  } catch {
    return Errors.forbidden("Knock event not allowed").toResponse();
  }

  const knockPdu = validatedKnock.event;
  await persistFederationMembershipEvent(input.env.DB, {
    roomId: input.roomId,
    event: knockPdu,
    source: "federation",
  });
  await notifyUsersOfEvent(input.envBindings, input.roomId, input.eventId, "m.room.member");
  input.waitUntil(
    fanoutEventToFederation(input.envBindings, input.roomId, knockPdu, {
      excludeServers: input.origin ? [input.origin] : undefined,
    }),
  );

  const strippedState: Array<Record<string, unknown>> = [];
  const strippedStateTypes = [
    "m.room.create",
    "m.room.name",
    "m.room.avatar",
    "m.room.join_rules",
    "m.room.canonical_alias",
  ] as const;
  const useFullCreateEvent = requiresFullCreateEventInStrippedState(room.roomVersion);
  for (const eventType of strippedStateTypes) {
    if (eventType === "m.room.create" && useFullCreateEvent) {
      const fullEvent = await getFederationFullCreateEvent(input.env.DB, input.roomId);
      if (fullEvent) {
        strippedState.push({
          event_id: fullEvent.event_id,
          room_id: fullEvent.room_id,
          type: fullEvent.event_type,
          state_key: fullEvent.state_key,
          content: JSON.parse(fullEvent.content),
          sender: fullEvent.sender,
          origin_server_ts: fullEvent.origin_server_ts,
          depth: fullEvent.depth,
          auth_events: JSON.parse(fullEvent.auth_events || "[]"),
          prev_events: JSON.parse(fullEvent.prev_events || "[]"),
          ...(fullEvent.hashes ? { hashes: JSON.parse(fullEvent.hashes) } : {}),
          ...(fullEvent.signatures ? { signatures: JSON.parse(fullEvent.signatures) } : {}),
        });
      }
      continue;
    }

    const events = await listFederationStrippedStateEvents(input.env.DB, input.roomId, eventType);
    const event = events[0];
    if (!event) {
      continue;
    }
    strippedState.push({
      type: event.type,
      state_key: event.state_key,
      content: JSON.parse(event.content),
      sender: event.sender,
    });
  }

  return new Response(JSON.stringify({ knock_room_state: strippedState }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
