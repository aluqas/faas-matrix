import type { ProfileField, ProfileResponseBody } from "../../../fatrix-model/types/profile";
import { getLocalProfileRecord } from "../../../platform/cloudflare/adapters/repositories/profile-repository";
import { fetchRemoteProfileResponse } from "../../../platform/cloudflare/adapters/application-ports/profile/profile-federation-gateway";
import { queryProfileResponse } from "../features/profile/profile-query";

export type FederationProfile = ProfileResponseBody;

export interface FederationProfileQueryInput {
  userId: string;
  field?: ProfileField;
  localServerName: string;
  db: D1Database;
  cache: KVNamespace;
  fetchProfile?(serverName: string, path: string): Promise<Response> | Response;
}

export class FederationQueryService {
  getProfile(input: FederationProfileQueryInput): Promise<FederationProfile | null> {
    return queryProfileResponse({
      userId: input.userId,
      ...(input.field ? { field: input.field } : {}),
      localServerName: input.localServerName,
      getLocalProfile: (userId) => getLocalProfileRecord(input.db, userId),
      fetchRemoteProfile: async (serverName, userId, field) => {
        if (input.fetchProfile) {
          const params = new URLSearchParams({ user_id: userId });
          if (field) {
            params.set("field", field);
          }
          const response = await input.fetchProfile(
            serverName,
            `/_matrix/federation/v1/query/profile?${params.toString()}`,
          );
          if (!response.ok) {
            return null;
          }
          const body = (await response.json()) as Partial<ProfileResponseBody>;
          return {
            displayname: body.displayname ?? null,
            avatar_url: body.avatar_url ?? null,
          };
        }

        return fetchRemoteProfileResponse(
          {
            SERVER_NAME: input.localServerName,
            DB: input.db,
            CACHE: input.cache,
          },
          serverName,
          userId,
          field,
        );
      },
    });
  }
}
