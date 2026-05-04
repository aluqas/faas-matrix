import type { Env } from "../../../env";
import {
  canonicalJson,
  generateSigningKeyPair,
  normalizeMatrixBase64,
  signJson,
} from "../../../../../fatrix-model/utils/crypto";
import type { ServerKeyResponse } from "../../../../../fatrix-backend/application/federation/query/query-shared";
import {
  getCurrentServerSigningKeyRecord,
  listCurrentServerKeys,
  replaceCurrentServerSigningKey,
} from "../../repositories/local-server-keys-repository";

const SERVER_KEY_VALIDITY_MS = 365 * 24 * 60 * 60 * 1000;

function canonicalJsonResponse(body: Record<string, unknown>): Response {
  return new Response(canonicalJson(body), {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

async function ensureCurrentServerSigningKey(
  db: D1Database,
): Promise<NonNullable<Awaited<ReturnType<typeof getCurrentServerSigningKeyRecord>>>> {
  const existing = await getCurrentServerSigningKeyRecord(db);
  if (existing) {
    return existing;
  }

  const generated = await generateSigningKeyPair();
  const validFrom = Date.now();
  const validUntil = validFrom + SERVER_KEY_VALIDITY_MS;
  await replaceCurrentServerSigningKey(db, {
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

function buildServerKeyResponse(
  serverName: string,
  keys: Awaited<ReturnType<typeof listCurrentServerKeys>>,
): ServerKeyResponse {
  const verifyKeys: Record<string, { key: string }> = {};
  for (const key of keys) {
    verifyKeys[key.keyId] = { key: normalizeMatrixBase64(key.publicKey) };
  }
  return {
    server_name: serverName,
    valid_until_ts: keys[0]?.validUntil ?? Date.now() + SERVER_KEY_VALIDITY_MS,
    verify_keys: verifyKeys,
    old_verify_keys: {},
  };
}

export async function queryCurrentLocalServerKeys(
  env: Pick<Env, "SERVER_NAME" | "DB">,
): Promise<Response> {
  const signingKey = await ensureCurrentServerSigningKey(env.DB);
  const keys = await listCurrentServerKeys(env.DB);
  const response = buildServerKeyResponse(env.SERVER_NAME, keys);
  const signed = (await signJson(
    response,
    env.SERVER_NAME,
    signingKey.keyId,
    signingKey.privateKeyJwk,
  )) as ServerKeyResponse;
  return canonicalJsonResponse(signed);
}

export async function queryLocalServerKeyById(
  env: Pick<Env, "SERVER_NAME" | "DB">,
  keyId: string,
): Promise<Response | null> {
  const keys = await listCurrentServerKeys(env.DB, keyId);
  if (keys.length === 0) {
    return null;
  }
  const signingKey = await ensureCurrentServerSigningKey(env.DB);
  const response = buildServerKeyResponse(env.SERVER_NAME, keys);
  const signed = (await signJson(
    response,
    env.SERVER_NAME,
    signingKey.keyId,
    signingKey.privateKeyJwk,
  )) as ServerKeyResponse;
  return canonicalJsonResponse(signed);
}
