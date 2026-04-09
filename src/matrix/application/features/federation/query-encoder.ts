import type { ServerKeyResponse } from "../../../../services/federation-keys";
import type { FederationProfile } from "../../federation-query-service";
import type { ProfileField } from "../../../../types/profile";
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
