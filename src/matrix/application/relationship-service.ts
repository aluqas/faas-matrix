import { getAuthChain } from "../../infra/db/database";
import {
  getRemoteServersForRelationRoom,
  getRoomVersionForRelations,
  queryRelationEventTree,
} from "../../infra/repositories/relations-repository";
import type { PDU } from "../../shared/types";
import type { EventRelationshipsRequest } from "../../shared/types/events";
import { fetchFederatedEventRelationshipsResponse } from "../../features/relations/gateway";

export type EventRelationshipsDirection = "up" | "down";

export type { EventRelationshipsRequest };

export interface EventRelationshipsResult {
  roomId: string;
  events: PDU[];
  limited: boolean;
  missingParentId?: string;
}

export function getRemoteServersForRoom(
  db: D1Database,
  roomId: string,
  localServerName: string,
): Promise<string[]> {
  return getRemoteServersForRelationRoom(db, roomId, localServerName);
}

export function fetchFederatedEventRelationships(
  db: D1Database,
  cache: KVNamespace,
  localServerName: string,
  roomVersion: string,
  remoteServerName: string,
  request: EventRelationshipsRequest,
): Promise<boolean> {
  return fetchFederatedEventRelationshipsResponse(
    {
      DB: db,
      CACHE: cache,
      SERVER_NAME: localServerName,
    },
    remoteServerName,
    roomVersion,
    request,
  );
}

export function queryEventRelationships(
  db: D1Database,
  request: EventRelationshipsRequest,
): Promise<EventRelationshipsResult | null> {
  return queryRelationEventTree(db, request);
}

export async function buildFederatedEventRelationshipsResponse(
  db: D1Database,
  request: EventRelationshipsRequest,
): Promise<{ events: PDU[]; limited: boolean; auth_chain: PDU[] } | null> {
  const result = await queryRelationEventTree(db, request);
  if (!result) {
    return null;
  }

  const authEventIds = Array.from(new Set(result.events.flatMap((event) => event.auth_events)));
  return {
    events: result.events,
    limited: result.limited,
    auth_chain: await getAuthChain(db, authEventIds),
  };
}

export function getRoomVersionForRelationships(
  db: D1Database,
  roomId: string,
): Promise<string> {
  return getRoomVersionForRelations(db, roomId);
}
