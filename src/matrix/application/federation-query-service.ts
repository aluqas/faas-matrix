import type { ProfileField, ProfileResponseBody } from "../../types/profile";
import { getLocalProfileRecord } from "../repositories/profile-repository";
import { fetchRemoteProfileResponse } from "./features/profile/profile-federation-gateway";
import { queryProfileResponse } from "./features/profile/profile-query";

export type FederationProfile = ProfileResponseBody;

export interface FederationProfileQueryInput {
  userId: string;
  field?: ProfileField;
  localServerName: string;
  db: D1Database;
  cache: KVNamespace;
}

export class FederationQueryService {
  getProfile(input: FederationProfileQueryInput): Promise<FederationProfile | null> {
    return queryProfileResponse({
      userId: input.userId,
      ...(input.field ? { field: input.field } : {}),
      localServerName: input.localServerName,
      getLocalProfile: (userId) => getLocalProfileRecord(input.db, userId),
      fetchRemoteProfile: (serverName, userId, field) =>
        fetchRemoteProfileResponse(
          {
            SERVER_NAME: input.localServerName,
            DB: input.db,
            CACHE: input.cache,
          },
          serverName,
          userId,
          field,
        ),
    });
  }
}
