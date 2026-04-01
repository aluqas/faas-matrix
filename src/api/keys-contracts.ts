export type JsonObject = Record<string, unknown>;

export interface DeviceKeysPayload extends JsonObject {
  user_id?: string;
  device_id?: string;
  unsigned?: JsonObject;
  algorithms?: string[];
  keys?: Record<string, string>;
  signatures?: Record<string, Record<string, string>>;
}

export interface CrossSigningKeyPayload extends JsonObject {
  user_id?: string;
  usage?: string[];
  keys?: Record<string, string>;
  signatures?: Record<string, Record<string, string>>;
}

export interface UIAAuthDict extends JsonObject {
  type?: string;
  session?: string;
  password?: string;
}

export interface KeysUploadRequest {
  device_keys?: DeviceKeysPayload;
  one_time_keys?: Record<string, JsonObject>;
  fallback_keys?: Record<string, JsonObject>;
}

export interface KeysQueryRequest {
  device_keys?: Record<string, string[]>;
}

export interface KeysQueryResponse {
  device_keys: Record<string, Record<string, DeviceKeysPayload>>;
  master_keys?: Record<string, CrossSigningKeyPayload>;
  self_signing_keys?: Record<string, CrossSigningKeyPayload>;
  user_signing_keys?: Record<string, CrossSigningKeyPayload>;
}

export interface KeysClaimRequest {
  one_time_keys?: Record<string, Record<string, string>>;
}

export interface CrossSigningUploadRequest {
  master_key?: CrossSigningKeyPayload;
  self_signing_key?: CrossSigningKeyPayload;
  user_signing_key?: CrossSigningKeyPayload;
  auth?: UIAAuthDict;
}

export interface CrossSigningKeysStore {
  master?: CrossSigningKeyPayload;
  self_signing?: CrossSigningKeyPayload;
  user_signing?: CrossSigningKeyPayload;
}

export interface SignedKeyPayload extends JsonObject {
  device_id?: string;
  signatures?: Record<string, Record<string, string>>;
}

export type SignaturesUploadRequest = Record<string, Record<string, SignedKeyPayload>>;

export interface TokenSubmitRequest {
  session?: string;
}

export interface UiaSessionData extends JsonObject {
  user_id: string;
  created_at: number;
  type: string;
  completed_stages: string[];
  is_oidc_user?: boolean;
  has_password?: boolean;
  redirect_url?: string;
  sso_completed_at?: number;
  token_completed_at?: number;
}

export interface StoredOneTimeKey {
  keyId: string;
  keyData: JsonObject;
  claimed: boolean;
}

export type StoredOneTimeKeyBuckets = Record<string, StoredOneTimeKey[]>;

function isPlainObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toJsonObject(value: unknown): JsonObject | null {
  return isPlainObject(value) ? value : null;
}

function toRecordOfStrings(value: unknown): Record<string, string> | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const entries = Object.entries(value).map(([key, entry]) =>
    typeof entry === "string" ? ([key, entry] as const) : null,
  );

  if (entries.some((entry) => entry === null)) {
    return null;
  }

  return Object.fromEntries(entries as Array<readonly [string, string]>) as Record<string, string>;
}

function toRecordOfStringRecords(value: unknown): Record<string, Record<string, string>> | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const entries = Object.entries(value).map(([key, entry]) => {
    const normalized = toRecordOfStrings(entry);
    return normalized ? ([key, normalized] as const) : null;
  });

  if (entries.some((entry) => entry === null)) {
    return null;
  }

  return Object.fromEntries(entries as Array<readonly [string, Record<string, string>]>) as Record<
    string,
    Record<string, string>
  >;
}

function toStringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? [...value]
    : null;
}

function toRecordOfJsonObjects(value: unknown): Record<string, JsonObject> | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const entries = Object.entries(value).map(([key, entry]) => {
    const normalized = toJsonObject(entry);
    return normalized ? [key, normalized] : null;
  });

  if (entries.some((entry) => entry === null)) {
    return null;
  }

  return Object.fromEntries(entries as Array<[string, JsonObject]>);
}

function toDeviceKeysRequestMap(value: unknown): Record<string, string[]> | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const entries = Object.entries(value).map(([userId, devices]) => {
    const normalized = toStringArray(devices);
    return normalized ? [userId, normalized] : null;
  });

  if (entries.some((entry) => entry === null)) {
    return null;
  }

  return Object.fromEntries(entries as Array<[string, string[]]>);
}

function toCrossSigningKeyPayload(value: unknown): CrossSigningKeyPayload | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const userId = value["user_id"];
  const usage = value["usage"];
  const keys = value["keys"];
  const signatures = value["signatures"];
  const parsedUsage = usage === undefined ? undefined : toStringArray(usage);
  const parsedKeys = keys === undefined ? undefined : toRecordOfStrings(keys);
  const parsedSignatures =
    signatures === undefined ? undefined : toRecordOfStringRecords(signatures);

  if (
    (userId !== undefined && typeof userId !== "string") ||
    (usage !== undefined && !parsedUsage) ||
    (keys !== undefined && !parsedKeys) ||
    (signatures !== undefined && !parsedSignatures)
  ) {
    return null;
  }

  return {
    ...value,
    ...(userId ? { user_id: userId } : {}),
    ...(parsedUsage ? { usage: parsedUsage } : {}),
    ...(parsedKeys ? { keys: parsedKeys } : {}),
    ...(parsedSignatures ? { signatures: parsedSignatures } : {}),
  };
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeJson(entry));
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalizeJson(entry)]),
    );
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

function toCrossSigningKeyMap(value: unknown): Record<string, CrossSigningKeyPayload> | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const entries = Object.entries(value).map(([userId, payload]) => {
    const parsed = toCrossSigningKeyPayload(payload);
    return parsed ? ([userId, parsed] as const) : null;
  });

  if (entries.some((entry) => entry === null)) {
    return null;
  }

  return Object.fromEntries(entries as Array<readonly [string, CrossSigningKeyPayload]>) as Record<
    string,
    CrossSigningKeyPayload
  >;
}

function toUserDeviceKeysMap(
  value: unknown,
): Record<string, Record<string, DeviceKeysPayload>> | null {
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
  ) as Record<string, Record<string, DeviceKeysPayload>>;
}

function toOneTimeClaims(value: unknown): Record<string, Record<string, string>> | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const userEntries = Object.entries(value).map(([userId, devices]) => {
    if (!isPlainObject(devices)) {
      return null;
    }

    const deviceEntries = Object.entries(devices).map(([deviceId, algorithm]) =>
      typeof algorithm === "string" ? [deviceId, algorithm] : null,
    );

    if (deviceEntries.some((entry) => entry === null)) {
      return null;
    }

    return [userId, Object.fromEntries(deviceEntries as Array<[string, string]>)] as const;
  });

  if (userEntries.some((entry) => entry === null)) {
    return null;
  }

  return Object.fromEntries(
    userEntries as Array<readonly [string, Record<string, string>]>,
  ) as Record<string, Record<string, string>>;
}

export function parseKeysUploadRequest(value: unknown): KeysUploadRequest | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const deviceKeys = value["device_keys"];
  const oneTimeKeys = value["one_time_keys"];
  const fallbackKeys = value["fallback_keys"];

  if (deviceKeys !== undefined && !isPlainObject(deviceKeys)) {
    return null;
  }

  const parsedOneTimeKeys =
    oneTimeKeys === undefined ? undefined : toRecordOfJsonObjects(oneTimeKeys);
  const parsedFallbackKeys =
    fallbackKeys === undefined ? undefined : toRecordOfJsonObjects(fallbackKeys);

  if (
    (oneTimeKeys !== undefined && !parsedOneTimeKeys) ||
    (fallbackKeys !== undefined && !parsedFallbackKeys)
  ) {
    return null;
  }

  return {
    ...(deviceKeys ? { device_keys: deviceKeys as DeviceKeysPayload } : {}),
    ...(parsedOneTimeKeys ? { one_time_keys: parsedOneTimeKeys } : {}),
    ...(parsedFallbackKeys ? { fallback_keys: parsedFallbackKeys } : {}),
  };
}

export function parseJsonObject(value: unknown): JsonObject | null {
  return toJsonObject(value);
}

export function parseDeviceKeysPayload(value: unknown): DeviceKeysPayload | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const userId = value["user_id"];
  const deviceId = value["device_id"];
  const unsigned = value["unsigned"];
  const algorithms = value["algorithms"];
  const keys = value["keys"];
  const signatures = value["signatures"];
  const parsedAlgorithms = algorithms === undefined ? undefined : toStringArray(algorithms);
  const parsedKeys = keys === undefined ? undefined : toRecordOfStrings(keys);
  const parsedSignatures =
    signatures === undefined ? undefined : toRecordOfStringRecords(signatures);

  if (
    (userId !== undefined && typeof userId !== "string") ||
    (deviceId !== undefined && typeof deviceId !== "string") ||
    (unsigned !== undefined && !isPlainObject(unsigned)) ||
    (algorithms !== undefined && !parsedAlgorithms) ||
    (keys !== undefined && !parsedKeys) ||
    (signatures !== undefined && !parsedSignatures)
  ) {
    return null;
  }

  return {
    ...value,
    ...(userId ? { user_id: userId } : {}),
    ...(deviceId ? { device_id: deviceId } : {}),
    ...(unsigned ? { unsigned } : {}),
    ...(parsedAlgorithms ? { algorithms: parsedAlgorithms } : {}),
    ...(parsedKeys ? { keys: parsedKeys } : {}),
    ...(parsedSignatures ? { signatures: parsedSignatures } : {}),
  };
}

export function parseDeviceKeysMap(value: unknown): Record<string, DeviceKeysPayload> | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const entries = Object.entries(value).map(([deviceId, payload]) => {
    const parsed = parseDeviceKeysPayload(payload);
    return parsed ? ([deviceId, parsed] as const) : null;
  });

  if (entries.some((entry) => entry === null)) {
    return null;
  }

  return Object.fromEntries(entries as Array<readonly [string, DeviceKeysPayload]>) as Record<
    string,
    DeviceKeysPayload
  >;
}

export function parseKeysQueryRequest(value: unknown): KeysQueryRequest | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const requested = value["device_keys"];
  if (requested === undefined) {
    return {};
  }

  const parsed = toDeviceKeysRequestMap(requested);
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

  const parsed = toOneTimeClaims(requested);
  return parsed ? { one_time_keys: parsed } : null;
}

export function parseCrossSigningUploadRequest(value: unknown): CrossSigningUploadRequest | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const master = value["master_key"];
  const selfSigning = value["self_signing_key"];
  const userSigning = value["user_signing_key"];
  const auth = value["auth"];

  if (
    (master !== undefined && !isPlainObject(master)) ||
    (selfSigning !== undefined && !isPlainObject(selfSigning)) ||
    (userSigning !== undefined && !isPlainObject(userSigning)) ||
    (auth !== undefined && !isPlainObject(auth))
  ) {
    return null;
  }

  return {
    ...(master ? { master_key: master as CrossSigningKeyPayload } : {}),
    ...(selfSigning ? { self_signing_key: selfSigning as CrossSigningKeyPayload } : {}),
    ...(userSigning ? { user_signing_key: userSigning as CrossSigningKeyPayload } : {}),
    ...(auth ? { auth: auth as UIAAuthDict } : {}),
  };
}

export function parseCrossSigningKeysStore(value: unknown): CrossSigningKeysStore | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const master = value["master"];
  const selfSigning = value["self_signing"];
  const userSigning = value["user_signing"];

  if (
    (master !== undefined && !toCrossSigningKeyPayload(master)) ||
    (selfSigning !== undefined && !toCrossSigningKeyPayload(selfSigning)) ||
    (userSigning !== undefined && !toCrossSigningKeyPayload(userSigning))
  ) {
    return null;
  }

  return {
    ...(master ? { master: toCrossSigningKeyPayload(master)! } : {}),
    ...(selfSigning ? { self_signing: toCrossSigningKeyPayload(selfSigning)! } : {}),
    ...(userSigning ? { user_signing: toCrossSigningKeyPayload(userSigning)! } : {}),
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
    (completedStages !== undefined && !toStringArray(completedStages)) ||
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
    user_id: userId,
    created_at: createdAt,
    type,
    completed_stages: toStringArray(completedStages) ?? [],
    ...(redirectUrl ? { redirect_url: redirectUrl } : {}),
    ...(isOidcUser !== undefined ? { is_oidc_user: isOidcUser } : {}),
    ...(hasPassword !== undefined ? { has_password: hasPassword } : {}),
    ...(ssoCompletedAt !== undefined ? { sso_completed_at: ssoCompletedAt } : {}),
    ...(tokenCompletedAt !== undefined ? { token_completed_at: tokenCompletedAt } : {}),
  };
}

export function parseStoredOneTimeKeyBuckets(value: unknown): StoredOneTimeKeyBuckets | null {
  if (!isPlainObject(value)) {
    return null;
  }

  const entries = Object.entries(value).map(([algorithm, keys]) => {
    if (!Array.isArray(keys)) {
      return null;
    }

    const normalizedKeys = keys.map((entry) => {
      if (!isPlainObject(entry)) {
        return null;
      }

      const keyId = entry["keyId"];
      const keyData = entry["keyData"];
      const claimed = entry["claimed"];
      if (typeof keyId !== "string" || !isPlainObject(keyData) || typeof claimed !== "boolean") {
        return null;
      }

      return {
        keyId,
        keyData,
        claimed,
      } satisfies StoredOneTimeKey;
    });

    if (normalizedKeys.some((entry) => entry === null)) {
      return null;
    }

    return [algorithm, normalizedKeys as StoredOneTimeKey[]] as const;
  });

  if (entries.some((entry) => entry === null)) {
    return null;
  }

  return Object.fromEntries(
    entries as Array<readonly [string, StoredOneTimeKey[]]>,
  ) as StoredOneTimeKeyBuckets;
}
