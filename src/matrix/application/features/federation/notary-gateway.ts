import type { AppEnv } from "../../../../types";
import {
  getRemoteKeysWithNotarySignature,
  type ServerKeyResponse,
  type SigningKey,
} from "../../../../services/federation-keys";
import { generateSigningKeyPair, signJson } from "../../../../utils/crypto";
import {
  getCurrentServerSigningKeyRecord,
  replaceCurrentServerSigningKey,
} from "../../../repositories/server-keys-repository";

const SERVER_KEY_VALIDITY_MS = 365 * 24 * 60 * 60 * 1000;

export async function getOrCreateNotarySigningKey(
  env: Pick<AppEnv["Bindings"], "DB">,
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
  env: Pick<AppEnv["Bindings"], "SERVER_NAME" | "DB" | "CACHE">,
  serverName: string,
  keyId: string | null,
  minimumValidUntilTs: number,
  notaryKey: SigningKey,
): Promise<ServerKeyResponse[]> {
  return getRemoteKeysWithNotarySignature(
    serverName,
    keyId,
    minimumValidUntilTs,
    env.DB,
    env.CACHE,
    env.SERVER_NAME,
    notaryKey.keyId,
    notaryKey.privateKeyJwk,
  );
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
