import type { UserId } from "../../../../types";
import type { ProfileField, ProfileResponseBody } from "../../../../types/profile";
import { isLocalServerName, parseUserId } from "../../../../utils/ids";

export interface ProfileLookupInput {
  userId: string;
  field?: ProfileField;
  localServerName: string;
  getLocalProfile(userId: UserId): Promise<ProfileResponseBody | null>;
  fetchRemoteProfile(
    serverName: string,
    userId: UserId,
    field?: ProfileField,
  ): Promise<ProfileResponseBody | null>;
}

function isSupportedProfileField(field: string | undefined): field is ProfileField {
  return field === undefined || field === "displayname" || field === "avatar_url";
}

export function queryProfileResponse(
  input: ProfileLookupInput,
): Promise<ProfileResponseBody | null> {
  const parsed = parseUserId(input.userId as `@${string}:${string}`);
  if (!parsed) {
    return Promise.resolve(null);
  }

  if (!isSupportedProfileField(input.field)) {
    return Promise.resolve(null);
  }

  const userId = input.userId as UserId;
  if (isLocalServerName(parsed.serverName, input.localServerName)) {
    return input.getLocalProfile(userId);
  }

  return input.fetchRemoteProfile(
    parsed.serverName,
    userId,
    input.field,
  );
}
