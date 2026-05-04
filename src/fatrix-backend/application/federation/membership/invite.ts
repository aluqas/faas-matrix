import type { EventId, MatrixSignatures, PDU, RoomId } from "../../../../fatrix-model/types";
import type { Env } from "../../../../platform/cloudflare/env";
import { Errors } from "../../../../fatrix-model/utils/errors";
import { getServerSigningKey } from "../../../../platform/cloudflare/adapters/federation/federation-keys";
import { signJson } from "../../../../fatrix-model/utils/crypto";
import {
  ensureFederatedRoomStub,
  persistFederationMembershipEvent,
  persistInviteStrippedState,
} from "../../orchestrators/federation-handler-service";
import { decideInvitePermission, loadInvitePermissionConfig } from "../../features/invite-permissions/policy";
import { runDomainValidation } from "../../domain-validation";
import { validateInviteRequest } from "../validation";
import { federationLocalUserExists } from "../../../../platform/cloudflare/adapters/repositories/federation-membership-read-repository";
import { toUserId } from "../../../../fatrix-model/utils/ids";

export async function processFederationInvite(input: {
  env: Pick<Env, "DB" | "SERVER_NAME">;
  roomId: RoomId;
  eventId: EventId;
  body: unknown;
  version: "v1" | "v2";
  origin?: string;
}): Promise<Response> {
  const validated = await runDomainValidation(
    validateInviteRequest({
      body: input.body,
      eventId: input.eventId,
      serverName: input.env.SERVER_NAME,
      requireRoomVersion: input.version === "v2",
    }),
  );

  const invitedUserId = toUserId(validated.invitedUserId);
  const sender = toUserId(validated.event.sender);
  if (!invitedUserId || !sender) {
    return Errors.invalidParam("userId", "Invalid user ID").toResponse();
  }

  const localUser = await federationLocalUserExists(input.env.DB, invitedUserId);
  if (!localUser) {
    return new Response(JSON.stringify({ errcode: "M_NOT_FOUND", error: "User not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }

  const invitePermissionConfig = await loadInvitePermissionConfig(input.env.DB, invitedUserId);
  const decision = decideInvitePermission(invitePermissionConfig, sender, input.origin);
  if (decision.action === "block") {
    return Errors.inviteBlocked().toResponse();
  }

  const key = await getServerSigningKey(input.env.DB);
  if (!key) {
    return new Response(
      JSON.stringify({ errcode: "M_UNKNOWN", error: "Server signing key not configured" }),
      { status: 500, headers: { "content-type": "application/json" } },
    );
  }

  const signedEvent = (await signJson(
    validated.event as unknown as Record<string, unknown>,
    input.env.SERVER_NAME,
    key.keyId,
    key.privateKeyJwk,
  )) as Record<string, unknown>;

  await ensureFederatedRoomStub(input.env.DB, input.roomId, validated.roomVersion, sender);

  const invitePdu: PDU = {
    ...validated.event,
    event_id: (signedEvent["event_id"] as PDU["event_id"] | undefined) ?? validated.event.event_id,
    room_id: input.roomId,
    sender: (signedEvent["sender"] as PDU["sender"] | undefined) ?? sender,
    type: (signedEvent["type"] as PDU["type"] | undefined) ?? validated.event.type,
    state_key:
      (signedEvent["state_key"] as PDU["state_key"] | undefined) ?? validated.event.state_key,
    content: (signedEvent["content"] as PDU["content"] | undefined) ?? validated.event.content,
    origin_server_ts:
      (signedEvent["origin_server_ts"] as PDU["origin_server_ts"] | undefined) ??
      validated.event.origin_server_ts,
    depth: (signedEvent["depth"] as PDU["depth"] | undefined) ?? validated.event.depth,
    auth_events:
      (signedEvent["auth_events"] as PDU["auth_events"] | undefined) ??
      validated.event.auth_events,
    prev_events:
      (signedEvent["prev_events"] as PDU["prev_events"] | undefined) ??
      validated.event.prev_events,
    unsigned: (signedEvent["unsigned"] as PDU["unsigned"] | undefined) ?? validated.event.unsigned,
    hashes: signedEvent["hashes"] as { sha256: string } | undefined,
    signatures: signedEvent["signatures"] as MatrixSignatures | undefined,
  };

  await persistFederationMembershipEvent(input.env.DB, {
    roomId: input.roomId,
    event: invitePdu,
    source: "federation",
  });
  await persistInviteStrippedState(input.env.DB, input.roomId, validated.inviteRoomState);

  return new Response(
    JSON.stringify(input.version === "v1" ? [200, signedEvent] : { event: signedEvent }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}
