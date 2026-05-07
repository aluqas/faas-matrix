import type { ServerKeyResponse } from "./query-shared";
import type { FederationProfile } from "../../legacy/federation-query-service";
import type { ProfileField } from "../../../../fatrix-model/types/profile";
import {
  encodeProfileFieldResponse,
  encodeProfileResponseBody,
} from "../../features/profile/encoder";

export function encodeFederationServerKeysResponse(serverKeys: ServerKeyResponse[]) {
  return { server_keys: serverKeys };
}

export function encodeFederationProfileResponse(profile: FederationProfile, field?: ProfileField) {
  return field === undefined
    ? encodeProfileResponseBody(profile)
    : encodeProfileFieldResponse(field, profile);
}
