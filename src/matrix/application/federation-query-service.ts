import { federationGet } from "../../services/federation-keys";
import { getUserById } from "../../services/database";
import type { ProfileField, ProfileResponseBody } from "../../types/profile";
import { isLocalServerName, parseUserId } from "../../utils/ids";

export type FederationProfile = ProfileResponseBody;

export interface FederationProfileQueryInput {
  userId: string;
  field?: ProfileField;
  localServerName: string;
  db: D1Database;
  cache: KVNamespace;
  fetchProfile?: (
    serverName: string,
    path: string,
    localServerName: string,
    db: D1Database,
    cache: KVNamespace,
  ) => Promise<Response>;
}

function isSupportedProfileField(field: string | undefined): field is ProfileField {
  return field === undefined || field === "displayname" || field === "avatar_url";
}

export class FederationQueryService {
  async getProfile(input: FederationProfileQueryInput): Promise<FederationProfile | null> {
    const parsed = parseUserId(input.userId);
    if (!parsed) {
      return null;
    }

    if (!isSupportedProfileField(input.field)) {
      return null;
    }

    if (isLocalServerName(parsed.serverName, input.localServerName)) {
      const user = await getUserById(input.db, input.userId);
      if (!user) {
        return null;
      }

      return {
        displayname: user.display_name ?? null,
        avatar_url: user.avatar_url ?? null,
      };
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

    const body = (await response.json()) as {
      displayname?: string | null;
      avatar_url?: string | null;
    };

    return {
      displayname: body.displayname ?? null,
      avatar_url: body.avatar_url ?? null,
    };
  }
}
