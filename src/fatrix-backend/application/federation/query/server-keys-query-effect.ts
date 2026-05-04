import { Effect } from "effect";
import { normalizeMatrixBase64 } from "../../../../fatrix-model/utils/crypto";
import { Errors, MatrixApiError } from "../../../../fatrix-model/utils/errors";
import { isLocalServerName } from "../../../../fatrix-model/utils/ids";
import { InfraError } from "../../domain-error";
import {
  isSafeFederationServerName,
  MAX_BATCH_SERVERS,
  type FederationQueryPorts,
  type FederationServerKeysBatchQueryInput,
  type FederationServerKeysQueryInput,
  type ServerKeyResponse,
  type SigningKey,
} from "./query-shared";

const SERVER_KEY_VALIDITY_FALLBACK_MS = 365 * 24 * 60 * 60 * 1000;

function sanitizeMinimumValidUntilTs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function toServerKeyNotFoundError(keyId?: string | null): MatrixApiError {
  return keyId ? Errors.notFound("Key not found") : Errors.notFound("No keys found for server");
}

function buildLocalServerKeysResponse(
  serverName: string,
  keys: Awaited<
    ReturnType<FederationQueryPorts["serverKeysRepository"]["getCurrentServerKeys"]>
  > extends Effect.Effect<infer A, unknown>
    ? A
    : never,
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
  return Effect.flatMap(ports.notaryGateway.getSigningKey(), (notaryKey) =>
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
  return Effect.flatMap(ports.serverKeysRepository.getCurrentServerKeys(keyId), (keys) => {
    const response = buildLocalServerKeysResponse(ports.localServerName, keys);
    if (!response) {
      return Effect.succeed(null);
    }
    return ports.notaryGateway.signResponse(response, notaryKey);
  });
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
        const responses = yield* ports.notaryGateway.getNotarizedServerKeys(
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
    const minimumValidUntilTs = sanitizeMinimumValidUntilTs(input.minimumValidUntilTs);
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

    const responses = yield* ports.notaryGateway.getNotarizedServerKeys(
      input.serverName,
      normalizedKeyId,
      minimumValidUntilTs,
      notaryKey,
    );
    if (responses.length === 0) {
      return yield* Effect.fail(toServerKeyNotFoundError(normalizedKeyId));
    }

    return responses;
  });
}
