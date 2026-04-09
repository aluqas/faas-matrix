import { makeFederationRequest } from "../../../../services/federation-keys";
import type { AppEnv, UserId } from "../../../../types";
import { isJsonObject } from "../../../../types/common";
import type { ProfileField, ProfileResponseBody } from "../../../../types/profile";
import { getOrCreateNotarySigningKey } from "../federation/notary-gateway";

function parseProfileResponseBody(value: unknown): ProfileResponseBody | null {
  if (!isJsonObject(value)) {
    return null;
  }

  const displayname = value["displayname"];
  const avatarUrl = value["avatar_url"];

  if (
    (displayname !== undefined && displayname !== null && typeof displayname !== "string") ||
    (avatarUrl !== undefined && avatarUrl !== null && typeof avatarUrl !== "string")
  ) {
    return null;
  }

  return {
    displayname: displayname ?? null,
    avatar_url: avatarUrl ?? null,
  };
}

export async function fetchRemoteProfileResponse(
  env: Pick<AppEnv["Bindings"], "SERVER_NAME" | "DB" | "CACHE">,
  serverName: string,
  userId: UserId,
  field?: ProfileField,
): Promise<ProfileResponseBody | null> {
  const params = new URLSearchParams({ user_id: userId });
  if (field) {
    params.set("field", field);
  }

  const signingKey = await getOrCreateNotarySigningKey({ DB: env.DB });
  if (!signingKey) {
    throw new Error("Server signing key not configured");
  }

  const response = await makeFederationRequest(
    "GET",
    serverName,
    `/_matrix/federation/v1/query/profile?${params.toString()}`,
    env.SERVER_NAME,
    signingKey,
    env.CACHE,
  );

  if (!response.ok) {
    return null;
  }

  return parseProfileResponseBody(await response.json().catch(() => null));
}
