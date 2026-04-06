import type {
  CrossSigningKeyPayload,
  CrossSigningKeysStore,
  CrossSigningUploadRequest,
  DeviceKeyRequestMap,
  DeviceKeysPayload,
  DeviceOneTimeKeysMap,
  JsonObject,
  JsonObjectMap,
  KeysClaimRequest,
  KeysQueryRequest,
  KeysQueryResponse,
  KeysUploadRequest,
  SignaturesUploadRequest,
  SignedKeyPayload,
  StoredOneTimeKeyBuckets,
  StringMap,
  TokenSubmitRequest,
  UIAAuthDict,
  UiaSessionData,
  UserCrossSigningKeyMap,
  UserDeviceKeysMap,
  UserOneTimeKeysMap,
} from "../types/client";
import {
  parseCrossSigningKeyPayload,
  parseDeviceKeyRequestMap,
  parseDeviceKeysMap,
  parseDeviceKeysPayload,
  parseJsonObject as parseJsonObjectValue,
  parseOneTimeKeyClaimMap,
  parseStringArray,
  parseStringMap,
} from "../types/e2ee";

export type {
  CrossSigningKeyPayload,
  CrossSigningKeysStore,
  CrossSigningUploadRequest,
  DeviceKeyRequestMap,
  DeviceKeysPayload,
  DeviceOneTimeKeysMap,
  JsonObject,
  JsonObjectMap,
  KeysClaimRequest,
  KeysQueryRequest,
  KeysQueryResponse,
  KeysUploadRequest,
  SignaturesUploadRequest,
  SignedKeyPayload,
  StoredOneTimeKeyBuckets,
  StringMap,
  TokenSubmitRequest,
  UIAAuthDict,
  UiaSessionData,
  UserCrossSigningKeyMap,
  UserDeviceKeysMap,
  UserOneTimeKeysMap,
};

export {
  parseCrossSigningKeysStore,
  parseDeviceKeysMap,
  parseDeviceKeysPayload,
  parseStoredOneTimeKeyBuckets,
} from "../types/e2ee";

export type { OneTimeKeyClaimMap } from "../types/client";

function isPlainObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toRecordOfStringRecords(value: unknown): Record<string, StringMap> | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const entries = Object.entries(value).map(([key, entry]) => {
    const normalized = parseStringMap(entry);
    return normalized ? ([key, normalized] as const) : null;
  });

  if (entries.some((entry) => entry === null)) {
    return null;
  }

  return Object.fromEntries(entries as Array<readonly [string, StringMap]>) as Record<
    string,
    StringMap
  >;
}

function toRecordOfJsonObjects(value: unknown): JsonObjectMap | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const entries = Object.entries(value).map(([key, entry]) => {
    const normalized = parseJsonObject(entry);
    return normalized ? [key, normalized] : null;
  });

  if (entries.some((entry) => entry === null)) {
    return null;
  }

  return Object.fromEntries(entries as Array<[string, JsonObject]>) as JsonObjectMap;
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeJson(entry));
  }

  if (isPlainObject(value)) {
    const sortedEntries = [...Object.entries(value)].sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return Object.fromEntries(sortedEntries.map(([key, entry]) => [key, canonicalizeJson(entry)]));
  }

  return value;
}

function canonicalJsonEquals(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalizeJson(left)) === JSON.stringify(canonicalizeJson(right));
}

export function isIdempotentCrossSigningUpload(
  existing: CrossSigningKeysStore,
  request: CrossSigningUploadRequest,
): boolean {
  let hasRequestedKey = false;

  const comparisons: Array<
    [CrossSigningKeyPayload | undefined, CrossSigningKeyPayload | undefined]
  > = [
    [existing.master, request.master_key],
    [existing.self_signing, request.self_signing_key],
    [existing.user_signing, request.user_signing_key],
  ];

  for (const [current, requested] of comparisons) {
    if (!requested) {
      continue;
    }
    hasRequestedKey = true;
    if (!current || !canonicalJsonEquals(current, requested)) {
      return false;
    }
  }

  return hasRequestedKey;
}

function toCrossSigningKeyMap(value: unknown): UserCrossSigningKeyMap | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const entries = Object.entries(value).map(([userId, payload]) => {
    const parsed = parseCrossSigningKeyPayload(payload);
    return parsed ? ([userId, parsed] as const) : null;
  });

  if (entries.some((entry) => entry === null)) {
    return null;
  }

  return Object.fromEntries(
    entries as Array<readonly [string, CrossSigningKeyPayload]>,
  ) as UserCrossSigningKeyMap;
}

function toUserDeviceKeysMap(value: unknown): UserDeviceKeysMap | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const entries = Object.entries(value).map(([userId, deviceMap]) => {
    const parsed = parseDeviceKeysMap(deviceMap);
    return parsed ? ([userId, parsed] as const) : null;
  });

  if (entries.some((entry) => entry === null)) {
    return null;
  }

  return Object.fromEntries(
    entries as Array<readonly [string, Record<string, DeviceKeysPayload>]>,
  ) as UserDeviceKeysMap;
}

export function parseKeysUploadRequest(value: unknown): KeysUploadRequest | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const deviceKeys = value["device_keys"];
  const oneTimeKeys = value["one_time_keys"];
  const fallbackKeys = value["fallback_keys"];
  const parsedDeviceKeys =
    deviceKeys === undefined ? undefined : parseDeviceKeysPayload(deviceKeys);

  const parsedOneTimeKeys =
    oneTimeKeys === undefined ? undefined : toRecordOfJsonObjects(oneTimeKeys);
  const parsedFallbackKeys =
    fallbackKeys === undefined ? undefined : toRecordOfJsonObjects(fallbackKeys);

  if (
    (deviceKeys !== undefined && !parsedDeviceKeys) ||
    (oneTimeKeys !== undefined && !parsedOneTimeKeys) ||
    (fallbackKeys !== undefined && !parsedFallbackKeys)
  ) {
    return null;
  }

  return {
    ...(parsedDeviceKeys ? { device_keys: parsedDeviceKeys } : {}),
    ...(parsedOneTimeKeys ? { one_time_keys: parsedOneTimeKeys } : {}),
    ...(parsedFallbackKeys ? { fallback_keys: parsedFallbackKeys } : {}),
  };
}

export function parseJsonObject(value: unknown): JsonObject | null {
  return parseJsonObjectValue(value);
}

export function parseKeysQueryRequest(value: unknown): KeysQueryRequest | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const requested = value["device_keys"];
  if (requested === undefined) {
    return {};
  }

  const parsed = parseDeviceKeyRequestMap(requested);
  return parsed ? { device_keys: parsed } : null;
}

export function parseKeysQueryResponse(value: unknown): KeysQueryResponse | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const deviceKeys = toUserDeviceKeysMap(value["device_keys"]);
  const masterKeys =
    value["master_keys"] === undefined ? undefined : toCrossSigningKeyMap(value["master_keys"]);
  const selfSigningKeys =
    value["self_signing_keys"] === undefined
      ? undefined
      : toCrossSigningKeyMap(value["self_signing_keys"]);
  const userSigningKeys =
    value["user_signing_keys"] === undefined
      ? undefined
      : toCrossSigningKeyMap(value["user_signing_keys"]);

  if (
    !deviceKeys ||
    (value["master_keys"] !== undefined && !masterKeys) ||
    (value["self_signing_keys"] !== undefined && !selfSigningKeys) ||
    (value["user_signing_keys"] !== undefined && !userSigningKeys)
  ) {
    return null;
  }

  return {
    device_keys: deviceKeys,
    ...(masterKeys ? { master_keys: masterKeys } : {}),
    ...(selfSigningKeys ? { self_signing_keys: selfSigningKeys } : {}),
    ...(userSigningKeys ? { user_signing_keys: userSigningKeys } : {}),
  };
}

export function parseKeysClaimRequest(value: unknown): KeysClaimRequest | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const requested = value["one_time_keys"];
  if (requested === undefined) {
    return {};
  }

  const parsed = parseOneTimeKeyClaimMap(requested);
  return parsed ? { one_time_keys: parsed } : null;
}

export function parseCrossSigningUploadRequest(value: unknown): CrossSigningUploadRequest | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const master = record["master_key"];
  const selfSigning = record["self_signing_key"];
  const userSigning = record["user_signing_key"];
  const auth = record["auth"];

  const parsedMaster = master === undefined ? undefined : parseCrossSigningKeyPayload(master);
  const parsedSelfSigning =
    selfSigning === undefined ? undefined : parseCrossSigningKeyPayload(selfSigning);
  const parsedUserSigning =
    userSigning === undefined ? undefined : parseCrossSigningKeyPayload(userSigning);

  if (
    (master !== undefined && !parsedMaster) ||
    (selfSigning !== undefined && !parsedSelfSigning) ||
    (userSigning !== undefined && !parsedUserSigning) ||
    (auth !== undefined && !isPlainObject(auth))
  ) {
    return null;
  }

  return {
    ...(parsedMaster ? { master_key: parsedMaster } : {}),
    ...(parsedSelfSigning ? { self_signing_key: parsedSelfSigning } : {}),
    ...(parsedUserSigning ? { user_signing_key: parsedUserSigning } : {}),
    ...(auth ? { auth: auth as UIAAuthDict } : {}),
  };
}

export function parseSignaturesUploadRequest(value: unknown): SignaturesUploadRequest | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const userEntries = Object.entries(value).map(([userId, keys]) => {
    if (!isPlainObject(keys)) {
      return null;
    }

    const keyEntries = Object.entries(keys).map(([keyId, payload]) => {
      if (!isPlainObject(payload)) {
        return null;
      }

      const deviceId = payload["device_id"];
      const signatures = payload["signatures"];
      const parsedSignatures =
        signatures === undefined ? undefined : toRecordOfStringRecords(signatures);
      if (
        (deviceId !== undefined && typeof deviceId !== "string") ||
        (signatures !== undefined && !parsedSignatures)
      ) {
        return null;
      }

      return [
        keyId,
        {
          ...payload,
          ...(deviceId ? { device_id: deviceId } : {}),
          ...(parsedSignatures ? { signatures: parsedSignatures } : {}),
        } satisfies SignedKeyPayload,
      ] as const;
    });

    if (keyEntries.some((entry) => entry === null)) {
      return null;
    }

    return [
      userId,
      Object.fromEntries(keyEntries as Array<readonly [string, SignedKeyPayload]>),
    ] as const;
  });

  if (userEntries.some((entry) => entry === null)) {
    return null;
  }

  return Object.fromEntries(
    userEntries as Array<readonly [string, Record<string, SignedKeyPayload>]>,
  ) as SignaturesUploadRequest;
}

export function parseTokenSubmitRequest(value: unknown): TokenSubmitRequest | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const session = value["session"];
  if (session !== undefined && typeof session !== "string") {
    return null;
  }

  return session ? { session } : {};
}

export function parseUiaSessionData(value: unknown): UiaSessionData | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const userId = value["user_id"];
  const createdAt = value["created_at"];
  const type = value["type"];
  const completedStages = value["completed_stages"];
  const redirectUrl = value["redirect_url"];
  const isOidcUser = value["is_oidc_user"];
  const hasPassword = value["has_password"];
  const ssoCompletedAt = value["sso_completed_at"];
  const tokenCompletedAt = value["token_completed_at"];

  if (
    typeof userId !== "string" ||
    typeof createdAt !== "number" ||
    typeof type !== "string" ||
    (completedStages !== undefined && !parseStringArray(completedStages)) ||
    (redirectUrl !== undefined && typeof redirectUrl !== "string") ||
    (isOidcUser !== undefined && typeof isOidcUser !== "boolean") ||
    (hasPassword !== undefined && typeof hasPassword !== "boolean") ||
    (ssoCompletedAt !== undefined && typeof ssoCompletedAt !== "number") ||
    (tokenCompletedAt !== undefined && typeof tokenCompletedAt !== "number")
  ) {
    return null;
  }

  return {
    ...value,
    user_id: userId as UiaSessionData["user_id"],
    created_at: createdAt,
    type,
    completed_stages: parseStringArray(completedStages) ?? [],
    ...(redirectUrl ? { redirect_url: redirectUrl } : {}),
    ...(isOidcUser !== undefined ? { is_oidc_user: isOidcUser } : {}),
    ...(hasPassword !== undefined ? { has_password: hasPassword } : {}),
    ...(ssoCompletedAt !== undefined ? { sso_completed_at: ssoCompletedAt } : {}),
    ...(tokenCompletedAt !== undefined ? { token_completed_at: tokenCompletedAt } : {}),
  };
}
