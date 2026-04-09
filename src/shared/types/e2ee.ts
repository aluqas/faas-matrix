import type {
  CrossSigningKeysStore,
  CrossSigningKeyPayload,
  DeviceKeyRequestMap,
  DeviceKeysPayload,
  OneTimeKeyClaimMap,
  StoredOneTimeKey,
  StoredOneTimeKeyBuckets,
  UserOneTimeKeysMap,
} from "./client";
import type { JsonObject } from "./common";
import { isJsonObject } from "./common";
import type { DeviceId, MatrixSignatures, UserId } from "./matrix";

export function parseJsonObject(value: unknown): JsonObject | null {
  return isJsonObject(value) ? value : null;
}

export interface FederationKeysQueryInput {
  requestedKeys: DeviceKeyRequestMap;
}

export interface FederationKeysClaimInput {
  requestedKeys: OneTimeKeyClaimMap;
}

export interface FederationUserDevicesInput {
  userId: UserId;
}

export interface FederationDeviceSignatureRecord {
  signerUserId: UserId;
  signerKeyId: string;
  signature: string;
}

export interface FederationClaimedOneTimeKeyRecord {
  keyId: string;
  keyData: JsonObject;
}

export interface FederationStoredDeviceRecord {
  deviceId: DeviceId;
  displayName: string | null;
}

export interface FederationUserDevice {
  device_id: DeviceId;
  keys?: DeviceKeysPayload;
  device_display_name?: string;
}

export interface FederationUserDevicesResponseBody {
  user_id: UserId;
  stream_id: number;
  devices: FederationUserDevice[];
  master_key?: CrossSigningKeyPayload;
  self_signing_key?: CrossSigningKeyPayload;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isUserIdLike(value: unknown): value is UserId {
  return typeof value === "string" && /^@[^:]+:.+$/.test(value);
}

export function parseStringArray(value: unknown): string[] | null {
  return isStringArray(value) ? [...value] : null;
}

export function parseStringMap(value: unknown): Record<string, string> | null {
  if (!isJsonObject(value)) {
    return null;
  }

  const entries = Object.entries(value).map(([key, entry]) =>
    typeof entry === "string" ? ([key, entry] as const) : null,
  );

  if (entries.some((entry) => entry === null)) {
    return null;
  }

  return Object.fromEntries(entries as Array<readonly [string, string]>);
}

export function parseMatrixSignatures(value: unknown): MatrixSignatures | null {
  if (!isJsonObject(value)) {
    return null;
  }

  const entries = Object.entries(value).map(([serverName, signatures]) => {
    const parsed = parseStringMap(signatures);
    return parsed ? ([serverName, parsed] as const) : null;
  });

  if (entries.some((entry) => entry === null)) {
    return null;
  }

  return Object.fromEntries(
    entries as Array<readonly [string, Record<string, string>]>,
  ) as MatrixSignatures;
}

export function parseDeviceKeysPayload(value: unknown): DeviceKeysPayload | null {
  if (!isJsonObject(value)) {
    return null;
  }

  const userId = value["user_id"];
  const deviceId = value["device_id"];
  const unsigned = value["unsigned"];
  const algorithms = value["algorithms"];
  const keys = value["keys"];
  const signatures = value["signatures"];

  let parsedAlgorithms: string[] | undefined;
  if (algorithms !== undefined) {
    if (!isStringArray(algorithms)) {
      return null;
    }
    parsedAlgorithms = algorithms;
  }

  let parsedKeys: Record<string, string> | undefined;
  if (keys !== undefined) {
    const normalized = parseStringMap(keys);
    if (!normalized) {
      return null;
    }
    parsedKeys = normalized;
  }

  let parsedSignatures: MatrixSignatures | undefined;
  if (signatures !== undefined) {
    const normalized = parseMatrixSignatures(signatures);
    if (!normalized) {
      return null;
    }
    parsedSignatures = normalized;
  }

  if (
    (userId !== undefined && !isUserIdLike(userId)) ||
    (deviceId !== undefined && typeof deviceId !== "string") ||
    (unsigned !== undefined && !isJsonObject(unsigned))
  ) {
    return null;
  }

  return {
    ...value,
    ...(userId !== undefined ? { user_id: userId } : {}),
    ...(deviceId !== undefined ? { device_id: deviceId } : {}),
    ...(unsigned !== undefined ? { unsigned } : {}),
    ...(parsedAlgorithms !== undefined ? { algorithms: parsedAlgorithms } : {}),
    ...(parsedKeys !== undefined ? { keys: parsedKeys } : {}),
    ...(parsedSignatures !== undefined ? { signatures: parsedSignatures } : {}),
  };
}

export const parseE2EEDeviceKeysPayload = parseDeviceKeysPayload;

export function parseDeviceKeysMap(value: unknown): Record<string, DeviceKeysPayload> | null {
  if (!isJsonObject(value)) {
    return null;
  }

  const entries = Object.entries(value).map(([deviceId, payload]) => {
    const parsed = parseDeviceKeysPayload(payload);
    return parsed ? ([deviceId, parsed] as const) : null;
  });

  if (entries.some((entry) => entry === null)) {
    return null;
  }

  return Object.fromEntries(entries as Array<readonly [string, DeviceKeysPayload]>);
}

export const parseE2EEDeviceKeysMap = parseDeviceKeysMap;

export function parseCrossSigningKeyPayload(value: unknown): CrossSigningKeyPayload | null {
  if (!isJsonObject(value)) {
    return null;
  }

  const userId = value["user_id"];
  const usage = value["usage"];
  const keys = value["keys"];
  const signatures = value["signatures"];

  let parsedUsage: string[] | undefined;
  if (usage !== undefined) {
    if (!isStringArray(usage)) {
      return null;
    }
    parsedUsage = usage;
  }

  let parsedKeys: Record<string, string> | undefined;
  if (keys !== undefined) {
    const normalized = parseStringMap(keys);
    if (!normalized) {
      return null;
    }
    parsedKeys = normalized;
  }

  let parsedSignatures: MatrixSignatures | undefined;
  if (signatures !== undefined) {
    const normalized = parseMatrixSignatures(signatures);
    if (!normalized) {
      return null;
    }
    parsedSignatures = normalized;
  }

  if (userId !== undefined && !isUserIdLike(userId)) {
    return null;
  }

  return {
    ...value,
    ...(userId !== undefined ? { user_id: userId } : {}),
    ...(parsedUsage !== undefined ? { usage: parsedUsage } : {}),
    ...(parsedKeys !== undefined ? { keys: parsedKeys } : {}),
    ...(parsedSignatures !== undefined ? { signatures: parsedSignatures } : {}),
  };
}

export function parseCrossSigningKeysStore(value: unknown): CrossSigningKeysStore | null {
  if (!isJsonObject(value)) {
    return null;
  }

  const master = value["master"];
  const selfSigning = value["self_signing"];
  const userSigning = value["user_signing"];

  const parsedMaster = master === undefined ? undefined : parseCrossSigningKeyPayload(master);
  const parsedSelfSigning =
    selfSigning === undefined ? undefined : parseCrossSigningKeyPayload(selfSigning);
  const parsedUserSigning =
    userSigning === undefined ? undefined : parseCrossSigningKeyPayload(userSigning);

  if (
    (master !== undefined && !parsedMaster) ||
    (selfSigning !== undefined && !parsedSelfSigning) ||
    (userSigning !== undefined && !parsedUserSigning)
  ) {
    return null;
  }

  return {
    ...(parsedMaster ? { master: parsedMaster } : {}),
    ...(parsedSelfSigning ? { self_signing: parsedSelfSigning } : {}),
    ...(parsedUserSigning ? { user_signing: parsedUserSigning } : {}),
  };
}

export const parseE2EECrossSigningKeysStore = parseCrossSigningKeysStore;

export function parseStoredOneTimeKeyBuckets(value: unknown): StoredOneTimeKeyBuckets | null {
  if (!isJsonObject(value)) {
    return null;
  }

  const entries = Object.entries(value).map(([algorithm, keys]) => {
    if (!Array.isArray(keys)) {
      return null;
    }

    const normalizedKeys = keys.map((entry) => {
      if (!isJsonObject(entry)) {
        return null;
      }

      const keyId = entry["keyId"];
      const keyData = entry["keyData"];
      const claimed = entry["claimed"];

      if (typeof keyId !== "string" || !isJsonObject(keyData) || typeof claimed !== "boolean") {
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

export function parseDeviceKeyRequestMap(value: unknown): DeviceKeyRequestMap | null {
  if (!isJsonObject(value)) {
    return null;
  }

  const entries = Object.entries(value).map(([userId, devices]) => {
    const parsedDevices = parseStringArray(devices);
    return parsedDevices ? ([userId, parsedDevices] as const) : null;
  });

  if (entries.some((entry) => entry === null)) {
    return null;
  }

  return Object.fromEntries(entries as Array<readonly [string, string[]]>) as DeviceKeyRequestMap;
}

export function parseOneTimeKeyClaimMap(value: unknown): OneTimeKeyClaimMap | null {
  if (!isJsonObject(value)) {
    return null;
  }

  const userEntries = Object.entries(value).map(([userId, devices]) => {
    if (!isJsonObject(devices)) {
      return null;
    }

    const deviceEntries = Object.entries(devices).map(([deviceId, algorithm]) =>
      typeof algorithm === "string" ? ([deviceId, algorithm] as const) : null,
    );

    if (deviceEntries.some((entry) => entry === null)) {
      return null;
    }

    return [userId, Object.fromEntries(deviceEntries as Array<readonly [string, string]>)] as const;
  });

  if (userEntries.some((entry) => entry === null)) {
    return null;
  }

  return Object.fromEntries(
    userEntries as Array<readonly [string, Record<string, string>]>,
  ) as OneTimeKeyClaimMap;
}

export function parseE2EEKeysQueryRequest(value: unknown): FederationKeysQueryInput | null {
  if (!isJsonObject(value)) {
    return null;
  }

  const requested = value["device_keys"];
  if (!isJsonObject(requested)) {
    return null;
  }

  const entries = parseDeviceKeyRequestMap(requested);
  if (!entries) {
    return null;
  }

  return {
    requestedKeys: entries,
  };
}

export function parseE2EEKeysClaimRequest(value: unknown): FederationKeysClaimInput | null {
  if (!isJsonObject(value)) {
    return null;
  }

  const requested = value["one_time_keys"];
  if (!isJsonObject(requested)) {
    return null;
  }

  const entries = parseOneTimeKeyClaimMap(requested);
  if (!entries) {
    return null;
  }

  return {
    requestedKeys: entries,
  };
}

export interface FederationKeysQueryResponseBody {
  device_keys: Record<string, Record<string, DeviceKeysPayload>>;
  master_keys?: Record<string, CrossSigningKeyPayload>;
  self_signing_keys?: Record<string, CrossSigningKeyPayload>;
}

export interface FederationKeysClaimResponseBody {
  one_time_keys: UserOneTimeKeysMap;
}
