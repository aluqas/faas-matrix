import type { ProfileField, ProfileResponseBody } from "../../../../types/profile";

export type ProfileFieldResponseBody =
  | Pick<ProfileResponseBody, "displayname">
  | Pick<ProfileResponseBody, "avatar_url">;

export function encodeProfileResponseBody(profile: ProfileResponseBody): ProfileResponseBody {
  return profile;
}

export function encodeProfileFieldResponse(
  field: ProfileField,
  profile: ProfileResponseBody,
): ProfileFieldResponseBody {
  return field === "displayname"
    ? { displayname: profile.displayname }
    : { avatar_url: profile.avatar_url };
}

export function encodeEmptyProfileResponse(): Record<string, never> {
  return {};
}
