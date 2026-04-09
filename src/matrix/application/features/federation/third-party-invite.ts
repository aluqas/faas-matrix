import type { AppEnv, EventId, PDU, RoomId } from "../../../../types";
import { Errors } from "../../../../utils/errors";
import { getServerSigningKey } from "../../../../services/federation-keys";
import { sha256, signJson, verifySignature } from "../../../../utils/crypto";
import { persistFederationMembershipEvent } from "../../federation-handler-service";
import { runDomainValidation } from "../../../../api/federation/shared";
import { validateThirdPartyInviteExchangeRequest } from "../../federation-validation";
import {
  deleteFederationThirdPartyInviteState,
  getFederationLatestEvent,
  getFederationRoomRecord,
  getFederationSenderMembershipEventId,
  getFederationStateEventId,
  getFederationThirdPartyInvite,
} from "../../../repositories/federation-membership-read-repository";
import { toEventId, toUserId } from "../../../../utils/ids";

export async function exchangeFederationThirdPartyInvite(input: {
  env: Pick<AppEnv["Bindings"], "DB" | "SERVER_NAME">;
  roomId: RoomId;
  body: unknown;
}): Promise<Response> {
  const validated = await runDomainValidation(
    validateThirdPartyInviteExchangeRequest({ body: input.body, roomId: input.roomId }),
  );

  const { mxid, token, signatures } = validated.signed;
  const sender = toUserId(validated.sender);
  const stateKey = toUserId(mxid);
  const validatedEventId = validated.eventId ? toEventId(validated.eventId) : null;
  if (!sender || !stateKey || (validated.eventId && !validatedEventId)) {
    return Errors.invalidParam("roomId", "Invalid third party invite identifiers").toResponse();
  }

  const room = await getFederationRoomRecord(input.env.DB, input.roomId);
  if (!room) {
    return Errors.notFound("Room not found").toResponse();
  }

  const thirdPartyInviteEvent = await getFederationThirdPartyInvite(input.env.DB, input.roomId, token);
  if (!thirdPartyInviteEvent) {
    return new Response(
      JSON.stringify({
        errcode: "M_FORBIDDEN",
        error: "No third party invite found with matching token",
      }),
      { status: 403, headers: { "content-type": "application/json" } },
    );
  }

  let inviteContent: {
    display_name?: string;
    key_validity_url?: string;
    public_key?: string;
    public_keys?: Array<{ public_key: string; key_validity_url?: string }>;
  };
  try {
    inviteContent = JSON.parse(thirdPartyInviteEvent.content);
  } catch {
    return new Response(
      JSON.stringify({
        errcode: "M_INVALID_PARAM",
        error: "Invalid third party invite content",
      }),
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  const signedDataForVerification: Record<string, unknown> = {
    mxid,
    sender: thirdPartyInviteEvent.sender,
    token,
    signatures,
  };

  let signatureValid = false;
  const publicKeys = inviteContent.public_keys ?? [];
  if (inviteContent.public_key) {
    publicKeys.push({ public_key: inviteContent.public_key });
  }
  for (const keyInfo of publicKeys) {
    const publicKey = keyInfo.public_key;
    if (!publicKey) continue;
    for (const [signingServer, keySignatures] of Object.entries(signatures)) {
      for (const [keyId, signature] of Object.entries(keySignatures)) {
        if (!signature) continue;
        try {
          const isValid = await verifySignature(
            signedDataForVerification,
            signingServer,
            keyId,
            publicKey,
          );
          if (isValid) {
            signatureValid = true;
            break;
          }
        } catch {}
      }
      if (signatureValid) break;
    }
    if (signatureValid) break;
  }

  if (!signatureValid) {
    return new Response(
      JSON.stringify({
        errcode: "M_FORBIDDEN",
        error: "Could not verify third party invite signature",
      }),
      { status: 403, headers: { "content-type": "application/json" } },
    );
  }

  const key = await getServerSigningKey(input.env.DB);
  if (!key) {
    return new Response(
      JSON.stringify({ errcode: "M_UNKNOWN", error: "Server signing key not configured" }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }

  const [createEventId, joinRulesEventId, powerLevelsEventId, senderMembershipEventId, latestEvent] =
    await Promise.all([
      getFederationStateEventId(input.env.DB, input.roomId, "m.room.create"),
      getFederationStateEventId(input.env.DB, input.roomId, "m.room.join_rules"),
      getFederationStateEventId(input.env.DB, input.roomId, "m.room.power_levels"),
      getFederationSenderMembershipEventId(input.env.DB, input.roomId, validated.sender),
      getFederationLatestEvent(input.env.DB, input.roomId),
    ]);

  const authEvents: EventId[] = [];
  for (const candidate of [
    createEventId,
    joinRulesEventId,
    powerLevelsEventId,
    senderMembershipEventId,
    thirdPartyInviteEvent.eventId,
  ]) {
    const eventId = candidate ? toEventId(candidate) : null;
    if (eventId) authEvents.push(eventId);
  }

  const latestEventId = latestEvent ? toEventId(latestEvent.eventId) : null;
  const prevEvents: EventId[] = latestEventId ? [latestEventId] : [];
  const depth = (latestEvent?.depth ?? 0) + 1;
  const originServerTs = Date.now();

  const inviteEvent = {
    room_id: input.roomId,
    sender,
    type: "m.room.member",
    state_key: stateKey,
    content: {
      membership: "invite",
      third_party_invite: {
        display_name: inviteContent.display_name ?? validated.displayName,
        signed: validated.signed,
      },
    },
    origin_server_ts: originServerTs,
    depth,
    auth_events: authEvents,
    prev_events: prevEvents,
  };

  const eventIdHash = await sha256(JSON.stringify({ ...inviteEvent, origin: input.env.SERVER_NAME }));
  const eventId = validatedEventId ?? `$${eventIdHash}`;

  const signedEvent = await signJson(
    { ...inviteEvent, event_id: eventId },
    input.env.SERVER_NAME,
    key.keyId,
    key.privateKeyJwk,
  );

  const storedPdu: PDU = {
    event_id: eventId,
    room_id: input.roomId,
    sender,
    type: "m.room.member",
    state_key: stateKey,
    content: inviteEvent.content,
    origin_server_ts: originServerTs,
    depth,
    auth_events: authEvents,
    prev_events: prevEvents,
    signatures: (signedEvent as any).signatures,
  };
  await persistFederationMembershipEvent(input.env.DB, {
    roomId: input.roomId,
    event: storedPdu,
    source: "federation",
  });
  await deleteFederationThirdPartyInviteState(input.env.DB, input.roomId, token);

  return new Response(JSON.stringify({}), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
