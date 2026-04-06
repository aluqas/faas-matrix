import { Effect } from "effect";
import { getRoomByAlias } from "../../../../services/database";
import {
  getRemoteKeysWithNotarySignature,
  getServerSigningKey,
  type ServerKeyResponse,
  type SigningKey,
} from "../../../../services/federation-keys";
import { normalizeMatrixBase64, signJson } from "../../../../utils/crypto";
import { Errors, MatrixApiError } from "../../../../utils/errors";
import { isLocalServerName, isValidServerName, parseUserId } from "../../../../utils/ids";
import { validateUrl } from "../../../../utils/url-validator";
import {
  listCurrentServerKeys,
  type CurrentServerKeyRecord,
} from "../../../repositories/server-keys-repository";
import { InfraError } from "../../domain-error";
import type { FederationProfile } from "../../federation-query-service";
import {
  buildFederatedEventRelationshipsResponse,
  type EventRelationshipsRequest,
} from "../../relationship-service";
import { queryProfileResponse } from "../profile/profile-query";
import type { ProfileField } from "../../../../types/profile";

const SERVER_KEY_VALIDITY_FALLBACK_MS = 365 * 24 * 60 * 60 * 1000;

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
  userId: string;
  field?: ProfileField;
}

export interface FederationDirectoryQueryInput {
  roomAlias: string;
}

export type FederationRelationshipsResult = Awaited<
  ReturnType<typeof buildFederatedEventRelationshipsResponse>
>;

export interface FederationQueryPorts {
  localServerName: string;
  getProfile(
    userId: string,
    field?: ProfileField,
  ): Effect.Effect<FederationProfile | null, InfraError>;
  getRoomByAlias(alias: string): Effect.Effect<string | null, InfraError>;
  getNotarySigningKey(): Effect.Effect<SigningKey | null, InfraError>;
  getCurrentServerKeys(keyId?: string | null): Effect.Effect<CurrentServerKeyRecord[], InfraError>;
  getNotarizedServerKeys(
    serverName: string,
    keyId: string | null,
    minimumValidUntilTs: number,
    notaryKey: SigningKey,
  ): Effect.Effect<ServerKeyResponse[], InfraError>;
  signNotaryResponse(
    response: ServerKeyResponse,
    notaryKey: SigningKey,
  ): Effect.Effect<ServerKeyResponse, InfraError>;
  buildEventRelationships(
    request: EventRelationshipsRequest,
  ): Effect.Effect<FederationRelationshipsResult | null, InfraError>;
}

function toInfraError(message: string, cause: unknown, status = 500): InfraError {
  return new InfraError({
    errcode: "M_UNKNOWN",
    message,
    status,
    cause,
  });
}

export function createFederationQueryPorts(input: {
  localServerName: string;
  db: D1Database;
  cache: KVNamespace;
}): FederationQueryPorts {
  return {
    localServerName: input.localServerName,
    getProfile: (userId, field) =>
      Effect.tryPromise({
        try: () =>
          queryProfileResponse({
            userId,
            ...(field ? { field } : {}),
            localServerName: input.localServerName,
            db: input.db,
            cache: input.cache,
          }),
        catch: (cause) => toInfraError("Failed to query federation profile", cause),
      }),
    getRoomByAlias: (alias) =>
      Effect.tryPromise({
        try: () => getRoomByAlias(input.db, alias),
        catch: (cause) => toInfraError("Failed to resolve room alias", cause),
      }),
    getNotarySigningKey: () =>
      Effect.tryPromise({
        try: () => getServerSigningKey(input.db),
        catch: (cause) => toInfraError("Failed to load notary signing key", cause),
      }),
    getCurrentServerKeys: (keyId) =>
      Effect.tryPromise({
        try: () => listCurrentServerKeys(input.db, keyId),
        catch: (cause) => toInfraError("Failed to load current server keys", cause),
      }),
    getNotarizedServerKeys: (serverName, keyId, minimumValidUntilTs, notaryKey) =>
      Effect.tryPromise({
        try: () =>
          getRemoteKeysWithNotarySignature(
            serverName,
            keyId,
            minimumValidUntilTs,
            input.db,
            input.cache,
            input.localServerName,
            notaryKey.keyId,
            notaryKey.privateKeyJwk,
          ),
        catch: (cause) => toInfraError("Failed to query notarized server keys", cause),
      }),
    signNotaryResponse: (response, notaryKey) =>
      Effect.tryPromise({
        try: async () =>
          (await signJson(
            response,
            input.localServerName,
            notaryKey.keyId,
            notaryKey.privateKeyJwk,
          )) as ServerKeyResponse,
        catch: (cause) => toInfraError("Failed to sign notary response", cause),
      }),
    buildEventRelationships: (request) =>
      Effect.tryPromise({
        try: () => buildFederatedEventRelationshipsResponse(input.db, request),
        catch: (cause) => toInfraError("Failed to build event relationships", cause),
      }),
  };
}

export function isSafeFederationServerName(serverName: string): boolean {
  if (!isValidServerName(serverName)) {
    return false;
  }

  return validateUrl(`https://${serverName}/`).valid;
}

function sanitizeMinimumValidUntilTs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function toServerKeyNotFoundError(keyId?: string | null): MatrixApiError {
  return keyId ? Errors.notFound("Key not found") : Errors.notFound("No keys found for server");
}

function buildLocalServerKeysResponse(
  serverName: string,
  keys: CurrentServerKeyRecord[],
): ServerKeyResponse | null {
  if (keys.length === 0) {
    return null;
  }

  const verifyKeys: Record<string, { key: string }> = {};
  let maxValidUntil = 0;

  for (const key of keys) {
    verifyKeys[key.keyId] = { key: normalizeMatrixBase64(key.publicKey) };
    if (key.validUntil && key.validUntil > maxValidUntil) {
      maxValidUntil = key.validUntil;
    }
  }

  return {
    server_name: serverName,
    valid_until_ts: maxValidUntil || Date.now() + SERVER_KEY_VALIDITY_FALLBACK_MS,
    verify_keys: verifyKeys,
    old_verify_keys: {},
  };
}

function requireNotarySigningKeyEffect(
  ports: FederationQueryPorts,
): Effect.Effect<SigningKey, MatrixApiError | InfraError> {
  return Effect.flatMap(ports.getNotarySigningKey(), (notaryKey) =>
    notaryKey
      ? Effect.succeed(notaryKey)
      : Effect.fail(Errors.unknown("Server signing key not configured")),
  );
}

function signLocalServerKeysEffect(
  ports: FederationQueryPorts,
  notaryKey: SigningKey,
  keyId?: string | null,
): Effect.Effect<ServerKeyResponse | null, InfraError> {
  return Effect.flatMap(ports.getCurrentServerKeys(keyId), (keys) => {
    const response = buildLocalServerKeysResponse(ports.localServerName, keys);
    if (!response) {
      return Effect.succeed(null);
    }
    return ports.signNotaryResponse(response, notaryKey);
  });
}

export function queryFederationProfileEffect(
  ports: FederationQueryPorts,
  input: FederationProfileQueryInput,
): Effect.Effect<FederationProfile, MatrixApiError | InfraError> {
  return Effect.gen(function* () {
    const parsed = parseUserId(input.userId as `@${string}:${string}`);
    if (!parsed || !isSafeFederationServerName(parsed.serverName)) {
      return yield* Effect.fail(Errors.invalidParam("user_id", "Invalid user_id"));
    }

    const profile = yield* ports.getProfile(input.userId, input.field);
    if (!profile) {
      return yield* Effect.fail(Errors.notFound("User not found"));
    }

    return profile;
  });
}

export function resolveFederationDirectoryEffect(
  ports: FederationQueryPorts,
  input: FederationDirectoryQueryInput,
): Effect.Effect<{ room_id: string; servers: string[] }, MatrixApiError | InfraError> {
  return Effect.flatMap(ports.getRoomByAlias(input.roomAlias), (roomId) =>
    roomId
      ? Effect.succeed({ room_id: roomId, servers: [ports.localServerName] })
      : Effect.fail(Errors.notFound("Room alias not found")),
  );
}

export function queryFederationServerKeysBatchEffect(
  ports: FederationQueryPorts,
  input: FederationServerKeysBatchQueryInput,
): Effect.Effect<ServerKeyResponse[], MatrixApiError | InfraError> {
  return Effect.gen(function* () {
    const serverEntries = Object.entries(input.serverKeys);
    if (serverEntries.length > MAX_BATCH_SERVERS) {
      return yield* Effect.fail(
        new MatrixApiError(
          "M_LIMIT_EXCEEDED",
          `Too many servers in batch request (max ${MAX_BATCH_SERVERS})`,
          400,
        ),
      );
    }

    const notaryKey = yield* requireNotarySigningKeyEffect(ports);
    const results: ServerKeyResponse[] = [];

    for (const [serverName, keyRequests] of serverEntries) {
      if (!isSafeFederationServerName(serverName)) {
        continue;
      }

      if (isLocalServerName(serverName, ports.localServerName)) {
        const signedLocalResponse = yield* signLocalServerKeysEffect(ports, notaryKey);
        if (signedLocalResponse) {
          results.push(signedLocalResponse);
        }
        continue;
      }

      for (const [keyId, keyRequest] of Object.entries(keyRequests ?? {})) {
        const minimumValidUntilTs = sanitizeMinimumValidUntilTs(keyRequest?.minimum_valid_until_ts);
        const responses = yield* ports.getNotarizedServerKeys(
          serverName,
          keyId === "" ? null : keyId,
          minimumValidUntilTs,
          notaryKey,
        );
        results.push(...responses);
      }
    }

    return results;
  });
}

export function queryFederationServerKeysEffect(
  ports: FederationQueryPorts,
  input: FederationServerKeysQueryInput,
): Effect.Effect<ServerKeyResponse[], MatrixApiError | InfraError> {
  return Effect.gen(function* () {
    if (!isSafeFederationServerName(input.serverName)) {
      return yield* Effect.fail(Errors.invalidParam("server_name", "Invalid server name"));
    }

    const notaryKey = yield* requireNotarySigningKeyEffect(ports);
    const sanitizedMinimumValidUntilTs = sanitizeMinimumValidUntilTs(input.minimumValidUntilTs);
    const normalizedKeyId = input.keyId ?? null;

    if (isLocalServerName(input.serverName, ports.localServerName)) {
      const signedLocalResponse = yield* signLocalServerKeysEffect(
        ports,
        notaryKey,
        normalizedKeyId,
      );
      if (!signedLocalResponse) {
        return yield* Effect.fail(toServerKeyNotFoundError(normalizedKeyId));
      }
      return [signedLocalResponse];
    }

    const responses = yield* ports.getNotarizedServerKeys(
      input.serverName,
      normalizedKeyId,
      sanitizedMinimumValidUntilTs,
      notaryKey,
    );
    if (responses.length === 0) {
      return yield* Effect.fail(toServerKeyNotFoundError(normalizedKeyId));
    }

    return responses;
  });
}

export function queryFederationEventRelationshipsEffect(
  ports: FederationQueryPorts,
  request: EventRelationshipsRequest,
): Effect.Effect<FederationRelationshipsResult, MatrixApiError | InfraError> {
  return Effect.flatMap(ports.buildEventRelationships(request), (result) =>
    result ? Effect.succeed(result) : Effect.fail(Errors.notFound("Event not found")),
  );
}
