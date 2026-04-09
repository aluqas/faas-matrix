import type { AppEnv, EventId, MatrixSignatures, PDU, RoomId } from "../../shared/types";
import { Errors } from "../../shared/utils/errors";
import { getServerSigningKey } from "../../infra/federation/federation-keys";
import { signJson } from "../../shared/utils/crypto";
import {
  ensureFederatedRoomStub,
  persistFederationMembershipEvent,
  persistInviteStrippedState,
} from "../../matrix/application/orchestrators/federation-handler-service";
import { decideInvitePermission, loadInvitePermissionConfig } from "../invite-permissions/policy";
import { runDomainValidation } from "../../api/federation/shared";
import { validateInviteRequest } from "../../matrix/application/federation-validation";
import { federationLocalUserExists } from "../../infra/repositories/federation-membership-read-repository";
import { toUserId } from "../../shared/utils/ids";

export async function processFederationInvite(input: {
  env: Pick<AppEnv["Bindings"], "DB" | "SERVER_NAME">;
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
  )) as Record<string, any>;

  await ensureFederatedRoomStub(input.env.DB, input.roomId, validated.roomVersion, sender);

  const invitePdu: PDU = {
    ...validated.event,
    event_id: signedEvent.event_id ?? validated.event.event_id,
    room_id: input.roomId,
    sender: signedEvent.sender ?? sender,
    type: signedEvent.type ?? validated.event.type,
    state_key: signedEvent.state_key ?? validated.event.state_key,
    content: signedEvent.content ?? validated.event.content,
    origin_server_ts: signedEvent.origin_server_ts ?? validated.event.origin_server_ts,
    depth: signedEvent.depth ?? validated.event.depth,
    auth_events: signedEvent.auth_events ?? validated.event.auth_events,
    prev_events: signedEvent.prev_events ?? validated.event.prev_events,
    unsigned: signedEvent.unsigned ?? validated.event.unsigned,
    hashes: signedEvent.hashes as { sha256: string } | undefined,
    signatures: signedEvent.signatures as MatrixSignatures | undefined,
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
