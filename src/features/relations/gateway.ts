import { federationPost } from "../../infra/federation/federation-keys";
import { isJsonObject } from "../../shared/types/common";
import type { EventRelationshipsRequest } from "../../shared/types/events";
import { storeEvent } from "../../infra/db/database";
import { tryValidateIncomingPdu } from "../../matrix/application/pdu-validator";

async function persistFederatedRelationshipResponse(
  db: D1Database,
  roomVersion: string,
  response: {
    events?: unknown[];
    auth_chain?: unknown[];
  },
): Promise<void> {
  const authChain = Array.isArray(response.auth_chain) ? response.auth_chain : [];
  const events = Array.isArray(response.events) ? response.events : [];

  for (const rawEvent of authChain) {
    const event = await tryValidateIncomingPdu(rawEvent, "auth_chain", roomVersion);
    if (event) {
      await storeEvent(db, event);
    }
  }

  for (const rawEvent of events) {
    const event = await tryValidateIncomingPdu(rawEvent, "event_relationships", roomVersion);
    if (event) {
      await storeEvent(db, event);
    }
  }
}

export async function fetchFederatedEventRelationshipsResponse(
  env: Pick<import("../../shared/types").AppEnv["Bindings"], "DB" | "CACHE" | "SERVER_NAME">,
  remoteServerName: string,
  roomVersion: string,
  request: EventRelationshipsRequest,
): Promise<boolean> {
  const response = await federationPost(
    remoteServerName,
    "/_matrix/federation/unstable/event_relationships",
    {
      event_id: request.eventId,
      ...(request.roomId ? { room_id: request.roomId } : {}),
      direction: request.direction,
      ...(request.includeParent !== undefined ? { include_parent: request.includeParent } : {}),
      ...(request.recentFirst !== undefined ? { recent_first: request.recentFirst } : {}),
      ...(request.maxDepth !== undefined ? { max_depth: request.maxDepth } : {}),
    },
    env.SERVER_NAME,
    env.DB,
    env.CACHE,
  );

  if (!response.ok) {
    return false;
  }

  const payload = await response.json();
  if (!isJsonObject(payload)) {
    return false;
  }

  await persistFederatedRelationshipResponse(env.DB, roomVersion, payload);
  return true;
}
