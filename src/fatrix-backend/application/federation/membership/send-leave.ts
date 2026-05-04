import type { EventId, PDU, RoomId } from "../../../../fatrix-model/types";
import type { Env } from "../../../../platform/cloudflare/env";
import { Errors } from "../../../../fatrix-model/utils/errors";
import { calculateReferenceHashEventId } from "../../../../fatrix-model/utils/crypto";
import { fanoutEventToFederation, notifyUsersOfEvent, storeEvent } from "../../../../platform/cloudflare/adapters/db/database";
import {
  applyMembershipTransitionToDatabase,
  loadMembershipTransitionContext,
} from "../../membership-transition-service";
import {
  federationEventExists,
  getFederationRoomRecord,
} from "../../../../platform/cloudflare/adapters/repositories/federation-membership-read-repository";
import { runDomainValidation } from "../../domain-validation";
import { validateSendLeaveRequest } from "../validation";

export async function processFederationSendLeave(input: {
  env: Pick<Env, "DB">;
  roomId: RoomId;
  eventId: EventId;
  body: unknown;
  origin?: string;
  version: "v1" | "v2";
  waitUntil: (promise: Promise<unknown>) => void;
  envBindings: Env;
}): Promise<Response> {
  const room = await getFederationRoomRecord(input.env.DB, input.roomId);
  if (!room) {
    return Errors.notFound("Room not found").toResponse();
  }

  const validatedLeave = await runDomainValidation(
    validateSendLeaveRequest({ body: input.body, roomId: input.roomId, eventId: input.eventId }),
  );
  const leavePdu: PDU = {
    ...validatedLeave.event,
    room_id: input.roomId,
  };

  const calculatedEventId = await calculateReferenceHashEventId(
    leavePdu as unknown as Record<string, unknown>,
    room.roomVersion,
  );
  console.warn("federation.send_leave.trace", {
    roomId: input.roomId,
    eventId: leavePdu.event_id,
    calculatedEventId,
    originServerTs: leavePdu.origin_server_ts,
    depth: leavePdu.depth,
    authEvents: leavePdu.auth_events,
    prevEvents: leavePdu.prev_events,
    pathMatchesCalculated: leavePdu.event_id === calculatedEventId,
  });

  const existing = await federationEventExists(input.env.DB, leavePdu.event_id);
  const leaveTransitionContext = await loadMembershipTransitionContext(
    input.env.DB,
    input.roomId,
    leavePdu.state_key,
  );
  if (!existing) {
    await storeEvent(input.env.DB, leavePdu);
  }

  await applyMembershipTransitionToDatabase(input.env.DB, {
    roomId: input.roomId,
    event: leavePdu,
    source: "federation",
    context: leaveTransitionContext,
  });

  await notifyUsersOfEvent(input.envBindings, input.roomId, leavePdu.event_id, "m.room.member");
  input.waitUntil(
    fanoutEventToFederation(input.envBindings, input.roomId, leavePdu, {
      excludeServers: input.origin ? [input.origin] : undefined,
    }),
  );

  return new Response(JSON.stringify(input.version === "v1" ? [200, {}] : {}), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
