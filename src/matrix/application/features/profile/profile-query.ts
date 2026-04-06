import { federationGet } from "../../../../services/federation-keys";
import { isJsonObject } from "../../../../types/common";
import type { ProfileField, ProfileResponseBody } from "../../../../types/profile";
import { isLocalServerName, parseUserId } from "../../../../utils/ids";
import { getLocalProfileRecord } from "../../../repositories/profile-repository";

export type ProfileFetchResponse = (
  serverName: string,
  path: string,
  localServerName: string,
  db: D1Database,
  cache: KVNamespace,
) => Promise<Response>;

export interface ProfileLookupInput {
  userId: string;
  field?: ProfileField;
  localServerName: string;
  db: D1Database;
  cache: KVNamespace;
  fetchProfile?: ProfileFetchResponse;
}

function isSupportedProfileField(field: string | undefined): field is ProfileField {
  return field === undefined || field === "displayname" || field === "avatar_url";
}

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

export async function queryProfileResponse(
  input: ProfileLookupInput,
): Promise<ProfileResponseBody | null> {
  const parsed = parseUserId(input.userId as `@${string}:${string}`);
  if (!parsed) {
    return null;
  }

  if (!isSupportedProfileField(input.field)) {
    return null;
  }

  if (isLocalServerName(parsed.serverName, input.localServerName)) {
    return getLocalProfileRecord(input.db, input.userId);
  }

  const fetchProfile = input.fetchProfile ?? federationGet;
  const path = new URLSearchParams({ user_id: input.userId });
  if (input.field) {
    path.set("field", input.field);
  }

  const response = await fetchProfile(
    parsed.serverName,
    `/_matrix/federation/v1/query/profile?${path.toString()}`,
    input.localServerName,
    input.db,
    input.cache,
  );

  if (!response.ok) {
    return null;
  }

  const parsedBody = parseProfileResponseBody(await response.json().catch(() => null));
  return parsedBody;
}
