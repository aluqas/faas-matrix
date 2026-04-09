import {
  getRemoteKeysWithNotarySignature,
  makeFederationRequest,
  type ServerKeyResponse,
  type SigningKey,
} from "../../../../services/federation-keys";
import type { AppEnv } from "../../../../types";

export type FederationGatewayEnv = Pick<AppEnv["Bindings"], "SERVER_NAME" | "DB" | "CACHE">;

export async function fetchFederationJson(
  env: FederationGatewayEnv,
  serverName: string,
  path: string,
  signingKey: SigningKey,
): Promise<unknown> {
  let response: Response;
  try {
    response = await makeFederationRequest(
      "GET",
      serverName,
      path,
      env.SERVER_NAME,
      signingKey,
      env.CACHE,
    );
  } catch (error) {
    throw new Error(`Federation GET failed for ${serverName}${path}`, { cause: error });
  }

  if (!response.ok) {
    return null;
  }

  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function fetchNotarizedServerKeysResponse(
  env: FederationGatewayEnv,
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
  ).catch((error) => {
    throw new Error(`Federation notary fetch failed for ${serverName}`, { cause: error });
  });
}
