import { Effect } from "effect";
import { isValidServerName } from "../../../../fatrix-model/utils/ids";
import { validateUrl } from "../../../../fetherate/utils/url-validator";
import { InfraError } from "../../domain-error";
import type { FederationProfile } from "../../legacy/federation-query-service";
import type { EventRelationshipsRequest } from "../../relationship-service";
import type { PDU, UserId } from "../../../../fatrix-model/types";
import type { ProfileField } from "../../../../fatrix-model/types/profile";

export const MAX_BATCH_SERVERS = 100;

export interface ServerKeyResponse {
  server_name: string;
  valid_until_ts: number;
  verify_keys: Record<string, { key: string }>;
  old_verify_keys?: Record<string, { key: string; expired_ts?: number }>;
  signatures?: Record<string, Record<string, string>>;
  [key: string]: unknown;
}

export interface SigningKey {
  keyId: string;
  privateKeyJwk: JsonWebKey;
}

export interface CurrentServerKeyRecord {
  keyId: string;
  publicKey: string;
  validUntil: number | null;
}

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

export interface FederationRelationshipsResult {
  events: PDU[];
  limited: boolean;
  auth_chain: PDU[];
}

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

export function isSafeFederationServerName(serverName: string): boolean {
  if (!isValidServerName(serverName)) {
    return false;
  }

  return validateUrl(`https://${serverName}/`).valid;
}
