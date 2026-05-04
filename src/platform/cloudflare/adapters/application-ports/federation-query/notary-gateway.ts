import type { Env } from "../../../env";
import type {
  ServerKeyResponse,
  SigningKey,
} from "../../../../../fatrix-backend/application/federation/query/query-shared";
import { generateSigningKeyPair, signJson } from "../../../../../fatrix-model/utils/crypto";
import { fetchNotarizedServerKeysResponse } from "../shared/federation-http-gateway";
import {
  getCurrentServerSigningKeyRecord,
  replaceCurrentServerSigningKey,
} from "../../repositories/server-keys-repository";

const SERVER_KEY_VALIDITY_MS = 365 * 24 * 60 * 60 * 1000;

export async function getOrCreateNotarySigningKey(
  env: Pick<Env, "DB">,
): Promise<SigningKey | null> {
  const existing = await getCurrentServerSigningKeyRecord(env.DB);
  if (existing) {
    return existing;
  }

  const generated = await generateSigningKeyPair();
  const validFrom = Date.now();
  const validUntil = validFrom + SERVER_KEY_VALIDITY_MS;

  await replaceCurrentServerSigningKey(env.DB, {
    keyId: generated.keyId,
    publicKey: generated.publicKey,
    privateKeyJwk: generated.privateKeyJwk,
    validFrom,
    validUntil,
  });

  return {
    keyId: generated.keyId,
    privateKeyJwk: generated.privateKeyJwk,
  };
}

export function fetchNotarizedServerKeys(
  env: Pick<Env, "SERVER_NAME" | "DB" | "CACHE">,
  serverName: string,
  keyId: string | null,
  minimumValidUntilTs: number,
  notaryKey: SigningKey,
): Promise<ServerKeyResponse[]> {
  return fetchNotarizedServerKeysResponse(env, serverName, keyId, minimumValidUntilTs, notaryKey);
}

export async function signNotaryServerKeyResponse(
  localServerName: string,
  response: ServerKeyResponse,
  notaryKey: SigningKey,
): Promise<ServerKeyResponse> {
  return (await signJson(
    response,
    localServerName,
    notaryKey.keyId,
    notaryKey.privateKeyJwk,
  )) as ServerKeyResponse;
}
