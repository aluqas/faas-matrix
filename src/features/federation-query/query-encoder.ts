import type { ServerKeyResponse } from "../../infra/federation/federation-keys";
import type { FederationProfile } from "../../matrix/application/legacy/federation-query-service";
import type { ProfileField } from "../../shared/types/profile";
import {
  encodeProfileFieldResponse,
  encodeProfileResponseBody,
} from "../profile/encoder";

export function encodeFederationServerKeysResponse(serverKeys: ServerKeyResponse[]) {
  return { server_keys: serverKeys };
}

export function encodeFederationProfileResponse(
  profile: FederationProfile,
  field?: ProfileField,
) {
  return field === undefined
    ? encodeProfileResponseBody(profile)
    : encodeProfileFieldResponse(field, profile);
}
