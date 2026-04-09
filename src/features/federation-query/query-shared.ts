import { Effect } from "effect";
import type { ServerKeyResponse, SigningKey } from "../../infra/federation/federation-keys";
import { isValidServerName } from "../../shared/utils/ids";
import { validateUrl } from "../../shared/utils/url-validator";
import { getLocalProfileRecord } from "../../infra/repositories/profile-repository";
import { findRoomIdByAlias } from "../../infra/repositories/room-directory-repository";
import {
  listCurrentServerKeys,
  type CurrentServerKeyRecord,
} from "../../infra/repositories/server-keys-repository";
import { InfraError } from "../../matrix/application/domain-error";
import type { FederationProfile } from "../../matrix/application/legacy/federation-query-service";
import {
  buildFederatedEventRelationshipsResponse,
  type EventRelationshipsRequest,
} from "../../matrix/application/relationship-service";
import { fetchRemoteProfileResponse } from "../profile/profile-federation-gateway";
import {
  fetchNotarizedServerKeys,
  getOrCreateNotarySigningKey,
  signNotaryServerKeyResponse,
} from "./notary-gateway";
import type { UserId } from "../../shared/types";
import type { ProfileField } from "../../shared/types/profile";
import { fromInfraNullable, fromInfraPromise } from "../../shared/effect/infra-effect";

export const MAX_BATCH_SERVERS = 100;

export interface FederationServerKeysBatchQueryInput {
  serverKeys: Record<string, Record<string, { minimum_valid_until_ts?: number } | undefined>>;
}

export interface FederationServerKeysQueryInput {
  serverName: string;
  keyId?: string | null;
  minimumValidUntilTs?: number;
}

export interface FederationProfileQueryInput {
  userId: UserId;
  field?: ProfileField;
}

export interface FederationDirectoryQueryInput {
  roomAlias: string;
}

export type FederationRelationshipsResult = Awaited<
  ReturnType<typeof buildFederatedEventRelationshipsResponse>
>;

export interface FederationProfileRepository {
  getLocalProfile(userId: UserId): Effect.Effect<FederationProfile | null, InfraError>;
}

export interface FederationProfileGateway {
  fetchRemoteProfile(
    serverName: string,
    userId: UserId,
    field?: ProfileField,
  ): Effect.Effect<FederationProfile | null, InfraError>;
}

export interface FederationRoomDirectoryRepository {
  findRoomIdByAlias(alias: string): Effect.Effect<string | null, InfraError>;
}

export interface FederationServerKeysRepository {
  getCurrentServerKeys(keyId?: string | null): Effect.Effect<CurrentServerKeyRecord[], InfraError>;
}

export interface FederationNotaryGateway {
  getSigningKey(): Effect.Effect<SigningKey | null, InfraError>;
  getNotarizedServerKeys(
    serverName: string,
    keyId: string | null,
    minimumValidUntilTs: number,
    notaryKey: SigningKey,
  ): Effect.Effect<ServerKeyResponse[], InfraError>;
  signResponse(
    response: ServerKeyResponse,
    notaryKey: SigningKey,
  ): Effect.Effect<ServerKeyResponse, InfraError>;
}

export interface FederationRelationshipsReader {
  buildEventRelationships(
    request: EventRelationshipsRequest,
  ): Effect.Effect<FederationRelationshipsResult | null, InfraError>;
}

export interface FederationQueryPorts {
  localServerName: string;
  profileRepository: FederationProfileRepository;
  profileGateway: FederationProfileGateway;
  roomDirectoryRepository: FederationRoomDirectoryRepository;
  serverKeysRepository: FederationServerKeysRepository;
  notaryGateway: FederationNotaryGateway;
  relationshipsReader: FederationRelationshipsReader;
}

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

  return {
    localServerName: input.localServerName,
    profileRepository: {
      getLocalProfile: (userId) =>
        fromInfraNullable(() => getLocalProfileRecord(input.db, userId), "Failed to query federation profile"),
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
          () => fetchNotarizedServerKeys(gatewayEnv, serverName, keyId, minimumValidUntilTs, notaryKey),
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
        fromInfraNullable(
          () => buildFederatedEventRelationshipsResponse(input.db, request),
          "Failed to build event relationships",
        ),
    },
  };
}

export function isSafeFederationServerName(serverName: string): boolean {
  if (!isValidServerName(serverName)) {
    return false;
  }

  return validateUrl(`https://${serverName}/`).valid;
}
