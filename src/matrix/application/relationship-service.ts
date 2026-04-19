import { Effect } from "effect";
import {
  getAuthChainForRelations,
  getRemoteServersForRelationRoom,
  getRoomVersionForRelations,
  queryRelationEventTree,
} from "../../infra/repositories/relations-repository";
import type { PDU } from "../../shared/types";
import type { EventRelationshipsRequest } from "../../shared/types/events";
import { fetchFederatedEventRelationshipsResponse } from "../../features/relations/gateway";
import { InfraError } from "./domain-error";
import { fromInfraPromise } from "../../shared/effect/infra-effect";

export type EventRelationshipsDirection = "up" | "down";

export type { EventRelationshipsRequest };

export interface EventRelationshipsResult {
  roomId: string;
  events: PDU[];
  limited: boolean;
  missingParentId?: string;
}

export interface RelationshipServicePorts {
  relationshipsRepository: {
    getRemoteServersForRoom(
      roomId: string,
      localServerName: string,
    ): Effect.Effect<string[], InfraError>;
    queryEventRelationships(
      request: EventRelationshipsRequest,
    ): Effect.Effect<EventRelationshipsResult | null, InfraError>;
    buildFederatedResponse(
      request: EventRelationshipsRequest,
    ): Effect.Effect<{ events: PDU[]; limited: boolean; auth_chain: PDU[] } | null, InfraError>;
    getRoomVersion(roomId: string): Effect.Effect<string, InfraError>;
  };
  relationshipsGateway: {
    fetchFederatedEventRelationships(
      remoteServerName: string,
      roomVersion: string,
      request: EventRelationshipsRequest,
    ): Effect.Effect<boolean, InfraError>;
  };
}

export function createRelationshipServicePorts(input: {
  db: D1Database;
  cache: KVNamespace;
  localServerName: string;
}): RelationshipServicePorts {
  return {
    relationshipsRepository: {
      getRemoteServersForRoom: (roomId, localServerName) =>
        fromInfraPromise(
          () => getRemoteServersForRelationRoom(input.db, roomId, localServerName),
          "Failed to load relation remote servers",
        ),
      queryEventRelationships: (request) =>
        fromInfraPromise(
          () => queryRelationEventTree(input.db, request),
          "Failed to query event relationships",
        ),
      buildFederatedResponse: (request) =>
        fromInfraPromise(
          () => buildFederatedEventRelationshipsResponse(input.db, request),
          "Failed to build federated event relationships response",
        ),
      getRoomVersion: (roomId) =>
        fromInfraPromise(
          () => getRoomVersionForRelations(input.db, roomId),
          "Failed to load relationship room version",
        ),
    },
    relationshipsGateway: {
      fetchFederatedEventRelationships: (remoteServerName, roomVersion, request) =>
        fromInfraPromise(
          () =>
            fetchFederatedEventRelationshipsResponse(
              {
                DB: input.db,
                CACHE: input.cache,
                SERVER_NAME: input.localServerName,
              },
              remoteServerName,
              roomVersion,
              request,
            ),
          "Failed to fetch federated event relationships",
        ),
    },
  };
}

export function getRemoteServersForRoomEffect(
  ports: RelationshipServicePorts,
  roomId: string,
  localServerName: string,
): Effect.Effect<string[], InfraError> {
  return ports.relationshipsRepository.getRemoteServersForRoom(roomId, localServerName);
}

export function fetchFederatedEventRelationshipsEffect(
  ports: RelationshipServicePorts,
  remoteServerName: string,
  roomVersion: string,
  request: EventRelationshipsRequest,
): Effect.Effect<boolean, InfraError> {
  return ports.relationshipsGateway.fetchFederatedEventRelationships(
    remoteServerName,
    roomVersion,
    request,
  );
}

export function queryEventRelationshipsEffect(
  ports: RelationshipServicePorts,
  request: EventRelationshipsRequest,
): Effect.Effect<EventRelationshipsResult | null, InfraError> {
  return ports.relationshipsRepository.queryEventRelationships(request);
}

export function buildFederatedEventRelationshipsResponseEffect(
  ports: RelationshipServicePorts,
  request: EventRelationshipsRequest,
): Effect.Effect<{ events: PDU[]; limited: boolean; auth_chain: PDU[] } | null, InfraError> {
  return ports.relationshipsRepository.buildFederatedResponse(request);
}

export function getRoomVersionForRelationshipsEffect(
  ports: RelationshipServicePorts,
  roomId: string,
): Effect.Effect<string, InfraError> {
  return ports.relationshipsRepository.getRoomVersion(roomId);
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
    auth_chain: await getAuthChainForRelations(db, authEventIds),
  };
}

export function getRoomVersionForRelationships(db: D1Database, roomId: string): Promise<string> {
  return getRoomVersionForRelations(db, roomId);
}
