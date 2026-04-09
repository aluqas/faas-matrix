import type { UserId } from "../../shared/types";
import type { ProfileField, ProfileResponseBody } from "../../shared/types/profile";
import { resolveLocalOrRemoteUserTarget } from "../shared/local-remote-dispatch";

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
  const target = resolveLocalOrRemoteUserTarget(
    input.userId as UserId,
    input.localServerName,
  );
  if (!target) {
    return Promise.resolve(null);
  }

  if (!isSupportedProfileField(input.field)) {
    return Promise.resolve(null);
  }

  if (target.isLocal) {
    return input.getLocalProfile(target.userId);
  }

  return input.fetchRemoteProfile(
    target.serverName,
    target.userId,
    input.field,
  );
}
