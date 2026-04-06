import type { ProfileField, ProfileResponseBody } from "../../types/profile";
import { type ProfileFetchResponse, queryProfileResponse } from "./features/profile/profile-query";

export type FederationProfile = ProfileResponseBody;

export interface FederationProfileQueryInput {
  userId: string;
  field?: ProfileField;
  localServerName: string;
  db: D1Database;
  cache: KVNamespace;
  fetchProfile?: ProfileFetchResponse;
}

export class FederationQueryService {
  getProfile(input: FederationProfileQueryInput): Promise<FederationProfile | null> {
    return queryProfileResponse(input);
  }
}
