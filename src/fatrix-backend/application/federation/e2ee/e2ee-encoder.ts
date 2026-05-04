import type {
  FederationKeysClaimResponseBody,
  FederationKeysQueryResponseBody,
  FederationUserDevicesResponseBody,
} from "../../../../fatrix-model/types";
import type {
  JsonObjectMap,
  UserCrossSigningKeyMap,
  UserDeviceKeysMap,
  UserOneTimeKeysMap,
} from "../../../../fatrix-model/types/client";

export function encodeFederationKeysQueryResponse(
  response: FederationKeysQueryResponseBody,
): FederationKeysQueryResponseBody {
  return response;
}

export function encodeFederationKeysClaimResponse(
  response: FederationKeysClaimResponseBody,
): FederationKeysClaimResponseBody {
  return response;
}

export function encodeFederationUserDevicesResponse(
  response: FederationUserDevicesResponseBody,
): FederationUserDevicesResponseBody {
  return response;
}

export function encodeClientKeysUploadResponse(oneTimeKeyCounts: Record<string, number>) {
  return {
    one_time_key_counts: oneTimeKeyCounts,
  };
}

export function encodeClientKeysQueryResponse(input: {
  deviceKeys: UserDeviceKeysMap;
  masterKeys: UserCrossSigningKeyMap;
  selfSigningKeys: UserCrossSigningKeyMap;
  userSigningKeys: UserCrossSigningKeyMap;
  failures: JsonObjectMap;
}) {
  return {
    device_keys: input.deviceKeys,
    master_keys: input.masterKeys,
    self_signing_keys: input.selfSigningKeys,
    user_signing_keys: input.userSigningKeys,
    failures: input.failures,
  };
}

export function encodeClientKeysClaimResponse(
  oneTimeKeys: UserOneTimeKeysMap,
  failures: JsonObjectMap,
) {
  return {
    one_time_keys: oneTimeKeys,
    failures,
  };
}

export function encodeClientKeysSignaturesUploadResponse(
  failures: Record<string, Record<string, { errcode: string; error: string }>>,
) {
  return { failures };
}

export function encodeClientKeysChangesResponse(changed: Iterable<string>, left: Iterable<string>) {
  return {
    changed: [...changed],
    left: [...left],
  };
}

export function encodeEmptyKeysResponse(): Record<string, never> {
  return {};
}
