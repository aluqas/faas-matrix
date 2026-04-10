import type { AppEnv, EventId, PDU, RoomId } from "../../shared/types";
import { Errors } from "../../shared/utils/errors";
import { calculateReferenceHashEventId } from "../../shared/utils/crypto";
import { checkEventAuth } from "../../infra/db/event-auth";
import { fanoutEventToFederation } from "../../infra/db/database";
import {
  persistFederationMembershipEvent,
  loadFederationStateBundle,
} from "../../matrix/application/orchestrators/federation-handler-service";
import {
  getFederationCurrentStateMembership,
  getFederationRoomRecord,
} from "../../infra/repositories/federation-membership-read-repository";
import { runDomainValidation } from "../../api/federation/shared";
import { validateSendJoinRequest } from "../../matrix/application/federation-validation";

export async function processFederationSendJoin(input: {
  env: Pick<AppEnv["Bindings"], "DB" | "SERVER_NAME">;
  roomId: RoomId;
  eventId: EventId;
  body: unknown;
  origin?: string;
  omitMembers: boolean;
  version: "v1" | "v2";
  waitUntil: (promise: Promise<unknown>) => void;
  buildPartialResponse: (stateBundle: {
    state: PDU[];
    authChain: PDU[];
    serversInRoom: string[];
  }) => {
    auth_chain: PDU[];
    state: PDU[];
    members_omitted: true;
    servers_in_room: string[];
  };
}): Promise<Response> {
  const validated = await runDomainValidation(
    validateSendJoinRequest({ body: input.body, roomId: input.roomId, eventId: input.eventId }),
  );

  const room = await getFederationRoomRecord(input.env.DB, input.roomId);
  if (!room) {
    return Errors.notFound("Room not found").toResponse();
  }

  const incomingEvent = validated.event;
  const currentMembership = await getFederationCurrentStateMembership(
    input.env.DB,
    input.roomId,
    incomingEvent.state_key ?? incomingEvent.sender,
  );
  if (currentMembership?.membership === "ban") {
    return new Response(
      JSON.stringify({ errcode: "M_FORBIDDEN", error: "User is banned from this room" }),
      { status: 403, headers: { "content-type": "application/json" } },
    );
  }

  const calculatedEventId = await calculateReferenceHashEventId(
    incomingEvent as unknown as Record<string, unknown>,
    room.roomVersion,
  );
  console.warn("federation.send_join.trace", {
    roomId: input.roomId,
    eventId: input.eventId,
    roomVersion: room.roomVersion,
    calculatedEventId,
    originServerTs: incomingEvent.origin_server_ts,
    depth: incomingEvent.depth,
    authEvents: incomingEvent.auth_events,
    prevEvents: incomingEvent.prev_events,
    pathMatchesCalculated: input.eventId === calculatedEventId,
  });

  const stateBundle = await loadFederationStateBundle(input.env.DB, input.roomId);
  const authResult = checkEventAuth(incomingEvent, stateBundle.roomState, room.roomVersion);
  if (!authResult.allowed) {
    return new Response(
      JSON.stringify({
        errcode: "M_FORBIDDEN",
        error: authResult.error ?? "Join event not allowed",
      }),
      { status: 403, headers: { "content-type": "application/json" } },
    );
  }

  await persistFederationMembershipEvent(input.env.DB, {
    roomId: input.roomId,
    event: incomingEvent,
    source: "federation",
  });

  input.waitUntil(
    fanoutEventToFederation(input.env as AppEnv["Bindings"], input.roomId, incomingEvent, {
      excludeServers: input.origin ? [input.origin] : undefined,
    }),
  );

  const partialResponse = input.omitMembers ? input.buildPartialResponse(stateBundle) : null;
  return new Response(
    JSON.stringify(
      input.version === "v1"
        ? {
            origin: input.env.SERVER_NAME,
            auth_chain: partialResponse?.auth_chain ?? stateBundle.authChain,
            state: partialResponse?.state ?? stateBundle.state,
            event: incomingEvent,
          }
        : {
            origin: input.env.SERVER_NAME,
            auth_chain: partialResponse?.auth_chain ?? stateBundle.authChain,
            state: partialResponse?.state ?? stateBundle.state,
            event: incomingEvent,
            members_omitted: partialResponse?.members_omitted ?? false,
            servers_in_room: stateBundle.serversInRoom,
          },
    ),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
