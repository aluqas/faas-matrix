import { FederationQueryService, type FederationProfile } from "../../federation-query-service";
import { buildFederatedEventRelationshipsResponse } from "../../relationship-service";
import type { FederationQueryInput } from "./contracts";

const federationQueryService = new FederationQueryService();

export interface FederationQueryPorts {
  localServerName: string;
  db: D1Database;
  cache: KVNamespace;
}

export async function runFederationQuery(
  ports: FederationQueryPorts,
  input: FederationQueryInput,
): Promise<
  FederationProfile | { events: unknown[]; limited: boolean; auth_chain: unknown[] } | null
> {
  if (input.kind === "profile") {
    return federationQueryService.getProfile({
      userId: input.userId,
      ...(input.field ? { field: input.field } : {}),
      localServerName: ports.localServerName,
      db: ports.db,
      cache: ports.cache,
    });
  }

  return buildFederatedEventRelationshipsResponse(ports.db, {
    eventId: input.eventId,
    direction: input.direction,
    ...(input.roomId ? { roomId: input.roomId } : {}),
    ...(input.includeParent !== undefined ? { includeParent: input.includeParent } : {}),
    ...(input.recentFirst !== undefined ? { recentFirst: input.recentFirst } : {}),
    ...(input.maxDepth !== undefined ? { maxDepth: input.maxDepth } : {}),
  });
}
