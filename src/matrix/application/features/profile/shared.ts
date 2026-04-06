import type { JsonObject } from "../../../../types/common";
import type { ProfileField } from "../../../../types/profile";
import type { UserId } from "../../../../types/matrix";
import { isJsonObject } from "../../../../types/common";
import { isLocalServerName, parseUserId } from "../../../../utils/ids";

const STANDARD_PROFILE_FIELDS: readonly ProfileField[] = ["displayname", "avatar_url"];

export function isStandardProfileField(value: string): value is ProfileField {
  return STANDARD_PROFILE_FIELDS.includes(value as ProfileField);
}

export function isLocalProfileUser(userId: UserId, localServerName: string): boolean {
  const parsed = parseUserId(userId);
  return !!parsed && isLocalServerName(parsed.serverName, localServerName);
}

export function parseStoredProfileCustomData(raw: string | null): JsonObject {
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return isJsonObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
