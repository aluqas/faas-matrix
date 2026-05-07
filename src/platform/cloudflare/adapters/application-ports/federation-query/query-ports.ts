import {
  buildFederatedEventRelationshipsResponseEffect,
  createRelationshipServicePorts,
} from "../../../../../fatrix-backend/application/relationship-service";
import {
  fromInfraNullable,
  fromInfraPromise,
} from "../../../../../fatrix-backend/application/effect/infra-effect";
import type { FederationQueryPorts } from "../../../../../fatrix-backend/application/federation/query/query-shared";
import { fetchRemoteProfileResponse } from "../profile/profile-federation-gateway";
import { getLocalProfileRecord } from "../../repositories/profile-repository";
import { findRoomIdByAlias } from "../../repositories/room-directory-repository";
import { listCurrentServerKeys } from "../../repositories/server-keys-repository";
import {
  fetchNotarizedServerKeys,
  getOrCreateNotarySigningKey,
  signNotaryServerKeyResponse,
} from "./notary-gateway";

export function createFederationQueryPorts(input: {
  localServerName: string;
  db: D1Database;
  cache: KVNamespace;
}): FederationQueryPorts {
  const gatewayEnv = {
    SERVER_NAME: input.localServerName,
    DB: input.db,
    CACHE: input.cache,
  };
  const relationshipPorts = createRelationshipServicePorts({
    db: input.db,
    cache: input.cache,
    localServerName: input.localServerName,
  });

  return {
    localServerName: input.localServerName,
    profileRepository: {
      getLocalProfile: (userId) =>
        fromInfraNullable(
          () => getLocalProfileRecord(input.db, userId),
          "Failed to query federation profile",
        ),
    },
    profileGateway: {
      fetchRemoteProfile: (serverName, userId, field) =>
        fromInfraNullable(
          () => fetchRemoteProfileResponse(gatewayEnv, serverName, userId, field),
          "Failed to query federation profile",
        ),
    },
    roomDirectoryRepository: {
      findRoomIdByAlias: (alias) =>
        fromInfraNullable(() => findRoomIdByAlias(input.db, alias), "Failed to resolve room alias"),
    },
    serverKeysRepository: {
      getCurrentServerKeys: (keyId) =>
        fromInfraPromise(
          () => listCurrentServerKeys(input.db, keyId),
          "Failed to load current server keys",
        ),
    },
    notaryGateway: {
      getSigningKey: () =>
        fromInfraNullable(
          () => getOrCreateNotarySigningKey({ DB: input.db }),
          "Failed to load notary signing key",
        ),
      getNotarizedServerKeys: (serverName, keyId, minimumValidUntilTs, notaryKey) =>
        fromInfraPromise(
          () =>
            fetchNotarizedServerKeys(gatewayEnv, serverName, keyId, minimumValidUntilTs, notaryKey),
          "Failed to query notarized server keys",
        ),
      signResponse: (response, notaryKey) =>
        fromInfraPromise(
          () => signNotaryServerKeyResponse(input.localServerName, response, notaryKey),
          "Failed to sign notary response",
        ),
    },
    relationshipsReader: {
      buildEventRelationships: (request) =>
        buildFederatedEventRelationshipsResponseEffect(relationshipPorts, request),
    },
  };
}
